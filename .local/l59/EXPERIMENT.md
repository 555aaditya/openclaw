# Control UI compile experiment — do not merge

This draft anchors a remote-clone performance experiment. It changes no product behavior.
The experiment compares the default Control UI build with startup V8 compile hints,
smaller boot chunks, and larger boot chunks on one fixed AWS instance type.

The experiment scripts are applied as a local Crabbox patch. Results will report
cold and warm reloads separately, with at least seven interleaved runs per variant.
The draft will close after measurement unless a variant justifies a reviewed product change.
