module.exports = function (api) {
  api.cache(true);
  return {
    // babel-preset-expo adds the Reanimated/worklets plugin by itself, and
    // Metro resolves the `@/` alias from tsconfig paths.
    presets: ['babel-preset-expo', 'nativewind/babel'],
  };
};
