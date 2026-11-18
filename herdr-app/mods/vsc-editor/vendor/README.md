# Prism 1.30.0

Tokenizer and grammar sources: [PrismJS/prism v1.30.0](https://github.com/PrismJS/prism/tree/v1.30.0), under the accompanying MIT license.

The bundle concatenates these upstream files, in order:

- components/prism-core.min.js
- components/prism-nix.min.js
- components/prism-verilog.min.js
- components/prism-vhdl.min.js

The wrapper shadows browser/Node integration globals and exports Prism as an ES module, so importing it does not change Herdr host globals. No DOM or worker APIs are used. Language additions and circuit-netlist rules are maintained separately in source-syntax.js.

To update, fetch the four files at a pinned upstream tag, keep the isolation wrapper and default export, and run the source preview regression suite and native mod check.
