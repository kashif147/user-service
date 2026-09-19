// jose@6.x ships as an ESM-only package ("type": "module", no separate CJS build).
// Node's own require() handles that via its newer require(esm) interop, but Jest's own
// module runtime does not - it needs the ESM syntax transformed to CJS first, which its
// default transformIgnorePatterns (["/node_modules/"]) prevents for every node_modules
// package including jose. This override un-ignores jose specifically so babel-jest (via
// this service's existing .babelrc, @babel/preset-env) transforms it like first-party code.
module.exports = {
  transformIgnorePatterns: ["/node_modules/(?!jose)/"],
};
