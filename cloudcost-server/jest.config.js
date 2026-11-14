module.exports = {
  moduleFileExtensions: ["ts", "js"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2020",
        },
      },
    ],
    // @typespec/ts-http-runtime pulls in the ESM-only proxy-agent chain, which
    // jest's CJS module registry cannot require natively - compile it here.
    "^.+\\.(js|mjs)$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2022",
          parser: {
            syntax: "ecmascript",
          },
        },
      },
    ],
  },
  transformIgnorePatterns: [
    "/node_modules/(?!(?:@typespec/ts-http-runtime|https-proxy-agent|http-proxy-agent|agent-base|proxy-agent-negotiate)/)",
  ],
  coverageProvider: "v8",
  testMatch: ["/**/src/**/*.spec.(ts|js)"],
  testEnvironment: "node",
};
