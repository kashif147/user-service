// .babelrc (already present in this service) is package-relative and never applies to
// files under node_modules regardless of jest's transformIgnorePatterns - a well-known
// Babel gotcha. babel.config.js is a project-ROOT config and does apply project-wide,
// which is what's needed here: jose@6.x ships ESM-only, and jest.config.js's
// transformIgnorePatterns override un-ignores node_modules/jose so babel-jest attempts to
// transform it, but without a root config the transform had nothing to actually do.
module.exports = {
  presets: [
    [
      "@babel/preset-env",
      {
        targets: {
          node: "current",
        },
      },
    ],
  ],
};
