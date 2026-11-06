# Preview retention

The public Pages artifact retains r25 (the previously shared early preview), r32 (the last review baseline), and r33 (the current TaN symmetry fix). Earlier r26–r31 bundles are preserved at Git tag `archive/previews-before-prune-20261106`; their former app URLs show an archive notice.

This avoids copying the same model, runtime, and source files into every Pages build. Before this cleanup `docs/` was about 814 MiB; afterward it is about 279 MiB. New reviews should replace the current review bundle or remove a superseded bundle after archiving it.
