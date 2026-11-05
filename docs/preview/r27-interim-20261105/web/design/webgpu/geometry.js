// Analytic MatterSim geometry and its reverse pass. No finite differences are
// used for inference. Ordered periodic images still come from Rust.
const f = value => {
  if (!Number.isFinite(value)) throw new Error('non-finite GPU geometry constant');
  return `${Math.fround(value).toString()}f`;
};

const dual = `
struct D { v:f32, d:vec2<f32> }
fn dc(v:f32)->D { return D(v,vec2<f32>(0.0)); }
fn da(a:D,b:D)->D { return D(a.v+b.v,a.d+b.d); }
fn db(a:D,b:D)->D { return D(a.v-b.v,a.d-b.d); }
fn ds(a:D,k:f32)->D { return D(a.v*k,a.d*k); }
fn dm(a:D,b:D)->D { return D(a.v*b.v,a.d*b.v+b.d*a.v); }
fn dd(a:D,b:D)->D { return D(a.v/b.v,(a.d-(a.v/b.v)*b.d)/b.v); }
fn sn(a:D)->D { return D(sin(a.v),a.d*cos(a.v)); }
fn cs(a:D)->D { return D(cos(a.v),-a.d*sin(a.v)); }
fn ac(a:D)->D { return D(acos(a.v),-a.d/sqrt(1.0-a.v*a.v)); }
fn poly(a:D)->D {
  let x=ds(a,0.25);let x2=dm(x,x);let x3=dm(x2,x);let x4=dm(x3,x);let x5=dm(x4,x);
  let value=db(da(da(ds(x5,-6.0),dc(1.0)),ds(x4,15.0)),ds(x3,10.0));
  if(value.v<0.0){return dc(0.0);} return value;
}`;

function radialExpressions(meta) {
  return Array.from({length:16},(_,index)=>{
    const l=Math.floor(index/4),j=index%4,p=k=>f(meta.sbf_coef[l][k][j]);
    let radial;
    if(l===0)radial=`dd(sn(ds(r,${p(0)})),r)`;
    if(l===1)radial=`dd(da(dm(ds(r,${p(0)}),cs(ds(r,${p(1)}))),ds(sn(ds(r,${p(3)})),${p(2)})),r2)`;
    if(l===2)radial=`dd(da(db(dm(ds(r2,${p(0)}),sn(ds(r,${p(1)}))),dm(ds(r,${p(2)}),cs(ds(r,${p(3)})))),ds(sn(ds(r,${p(5)})),${p(4)})),r3)`;
    if(l===3)radial=`dd(da(db(db(dm(ds(r3,${p(0)}),cs(ds(r,${p(1)}))),dm(ds(r2,${p(2)}),sn(ds(r,${p(3)})))),dm(ds(r,${p(4)}),cs(ds(r,${p(5)})))),ds(sn(ds(r,${p(7)})),${p(6)})),r4)`;
    const harmonic=[`dc(${f(.5*Math.sqrt(1/Math.PI))})`,`ds(hc,${f(Math.sqrt(3/(4*Math.PI)))})`,
      `ds(db(ds(c2,3.0),dc(1.0)),${f(Math.sqrt(5/(16*Math.PI)))})`,
      `ds(dm(hc,db(ds(c2,5.0),dc(3.0))),${f(Math.sqrt(7/(16*Math.PI)))})`][l];
    return `case ${index}u: { value=ds(dm(${radial},${harmonic}),${f(meta.sbf_factor)}); }`;
  }).join('\n');
}

export class GpuGeometry {
  constructor(rt,graph,meta) {
    this.rt=rt;this.graph=graph;this.meta=meta;
    const n=graph.atomic_numbers.length,e=graph.source.length,t=graph.triple_first.length;
    this.n=n;this.e=e;this.t=t;
    this.source=rt.indices(graph.source,n);this.dest=rt.indices(graph.destination,n);
    this.first=rt.indices(graph.triple_first,e);this.second=rt.indices(graph.triple_second,e);
    const pos=rt.tensor(graph.positions_a.flat(),n,3),cell=rt.tensor(graph.cell_a.flat(),3,3),offset=rt.tensor(graph.offsets.flat(),e,3);
    this.cell=cell;
    this.vector=rt.kernel([pos,cell,offset,this.source,this.dest],e,3,`
      var image=0.0;
      for(var k=0u;k<3u;k++){image+=x2[row*3u+k]*x1[k*3u+col];}
      y[i]=x0[x3[row]*3u+col]-(x0[x4[row]*3u+col]+image);`,true);
    this.length=this.norm(this.vector);
    const rij=rt.gather(this.length,this.first),rik=rt.gather(this.length,this.second);
    const cosine=this.cosine(rt.gather(this.vector,this.first),rt.gather(this.vector,this.second),rij,rik);
    this.rbf=this.radialBasis(this.length);
    this.sbf=this.sphericalBasis(rik,cosine);
    this.cutoff=this.cutoffBasis(rij,rik);
  }

  norm(vector) {
    const rt=this.rt;
    const out=rt.kernel([vector],vector.rows,1,`
      var v=fma(x0[row*3u],x0[row*3u],0.0);
      v=fma(x0[row*3u+1u],x0[row*3u+1u],v);
      v=fma(x0[row*3u+2u],x0[row*3u+2u],v);y[i]=sqrt(v);`,true);
    return rt.track(out,g=>rt.accumulate(vector,rt.kernel([g,out,vector],vector.rows,3,'y[i]=x2[i]*(x0[row]/x1[row]);')));
  }

  cosine(a,b,la,lb) {
    const rt=this.rt;
    const raw=(ai,bi,lai,lbi)=>`(x${ai}[row*3u]*x${bi}[row*3u]+x${ai}[row*3u+1u]*x${bi}[row*3u+1u]+x${ai}[row*3u+2u]*x${bi}[row*3u+2u])/(x${lai}[row]*x${lbi}[row])`;
    const out=rt.kernel([a,b,la,lb],a.rows,1,`y[i]=clamp(${raw(0,1,2,3)},-0.9999999,0.9999999);`,true);
    return rt.track(out,g=>{
      const inputs=[g,a,b,la,lb];
      const mask=`let raw=${raw(1,2,3,4)};if(raw < -0.9999999 || raw > 0.9999999){y[i]=0.0;return;}`;
      rt.accumulate(a,rt.kernel(inputs,a.rows,3,`${mask} y[i]=x0[row]*x2[i]/(x3[row]*x4[row]);`));
      rt.accumulate(b,rt.kernel(inputs,b.rows,3,`${mask} y[i]=x0[row]*x1[i]/(x3[row]*x4[row]);`));
      rt.accumulate(la,rt.kernel(inputs,la.rows,1,`${mask} y[i]=-x0[row]*raw/x3[row];`));
      rt.accumulate(lb,rt.kernel(inputs,lb.rows,1,`${mask} y[i]=-x0[row]*raw/x4[row];`));
    });
  }

  radialBasis(length) {
    const rt=this.rt,m=this.meta;
    let recurrence='';
    for(let k=0;k<4;k++) {
      recurrence+=`let a${k}=ds(radius,${f(m.n1[k])});let b${k}=ds(radius,${f(m.n2[k])});
        let fn${k}=ds(da(dd(sn(a${k}),a${k}),dd(sn(b${k}),b${k})),${f(m.fnr_weights[k])});\n`;
      recurrence+=k===0?'values[0]=fn0;\n':`values[${k}]=ds(da(fn${k},ds(values[${k-1}],${f(Math.sqrt(Math.fround(m.en[k]/m.dn[k-1])))})),${f(1/Math.sqrt(m.dn[k]))});\n`;
    }
    const packed=rt.kernel([length],length.rows,8,`
      if(col>=4u){return;}let radius=D(x0[row],vec2<f32>(1.0,0.0));var values:array<D,4>;
      ${recurrence}
      y[row*8u+col]=values[col].v;y[row*8u+col+4u]=values[col].d.x;`,false,dual);
    const out=rt.kernel([packed],length.rows,4,'y[i]=x0[row*8u+col];',true);
    return rt.track(out,g=>rt.accumulate(length,rt.kernel([g,packed],length.rows,1,`
      var v=0.0;for(var k=0u;k<4u;k++){v+=x0[row*4u+k]*x1[row*8u+4u+k];}y[i]=v;`)));
  }

  sphericalBasis(length,cosine) {
    const rt=this.rt;
    const packed=rt.kernel([length,cosine],length.rows,48,`
      if(col>=16u){return;}
      let r=ds(D(x0[row],vec2<f32>(1.0,0.0)),0.2);let r2=dm(r,r);let r3=dm(r2,r);let r4=dm(r3,r);
      let hc=cs(ac(D(x1[row],vec2<f32>(0.0,1.0))));let c2=dm(hc,hc);var value=dc(0.0);
      switch col { ${radialExpressions(this.meta)} default: {} }
      y[row*48u+col]=value.v;y[row*48u+16u+col]=value.d.x;y[row*48u+32u+col]=value.d.y;`,false,dual);
    const out=rt.kernel([packed],length.rows,16,'y[i]=x0[row*48u+col];',true);
    return rt.track(out,g=>{
      for(const [target,offset] of [[length,16],[cosine,32]]) {
        rt.accumulate(target,rt.kernel([g,packed],length.rows,1,`
          var v=0.0;for(var k=0u;k<16u;k++){v+=x0[row*16u+k]*x1[row*48u+${offset}u+k];}y[i]=v;`));
      }
    });
  }

  cutoffBasis(a,b) {
    const rt=this.rt;
    const packed=rt.kernel([a,b],a.rows,3,`
      if(col>0u){return;}let v=dm(poly(D(x0[row],vec2<f32>(1.0,0.0))),poly(D(x1[row],vec2<f32>(0.0,1.0))));
      y[row*3u]=v.v;y[row*3u+1u]=v.d.x;y[row*3u+2u]=v.d.y;`,false,dual);
    const out=rt.kernel([packed],a.rows,1,'y[i]=x0[row*3u];',true);
    return rt.track(out,g=>{
      rt.accumulate(a,rt.kernel([g,packed],a.rows,1,'y[i]=x0[row]*x1[row*3u+1u];'));
      rt.accumulate(b,rt.kernel([g,packed],b.rows,1,'y[i]=x0[row]*x1[row*3u+2u];'));
    });
  }

  outputs(periodic) {
    const rt=this.rt,gradient=this.vector.grad;
    if(!gradient)throw new Error('missing GPU geometry derivative');
    const from=rt.scatter(gradient,this.source,this.n),to=rt.scatter(gradient,this.dest,this.n);
    const forces=rt.kernel([to,from],this.n,3,'y[i]=x0[i]-x1[i];');
    const [a,b,c]=this.graph.cell_a;
    const volume=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
    if(!Number.isFinite(volume)||Math.abs(volume)<1e-12)throw new Error('invalid GPU cell volume');
    // Keep cell volume as runtime data. Embedding this per-step determinant in
    // WGSL creates a distinct stress pipeline at every FIRE cell update.
    const stress=periodic?rt.kernel([this.vector,gradient,this.cell],3,3,`
      let volume=x2[0]*(x2[4]*x2[8]-x2[5]*x2[7])-x2[1]*(x2[3]*x2[8]-x2[5]*x2[6])+x2[2]*(x2[3]*x2[7]-x2[4]*x2[6]);
      var value=0.0;for(var edge=0u;edge<${this.e}u;edge++){value+=x0[edge*3u+row]*x1[edge*3u+col];}y[i]=value/volume;`)
      :rt.tensor(new Float32Array(9),3,3);
    return {forces,stress};
  }
}
