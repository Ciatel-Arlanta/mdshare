// Copies the built reader page (reader/dist) into the Android app's assets so
// the WebView can load it from file:///android_asset/reader/.
const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withReaderAssets(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'reader', 'dist');
      if (!fs.existsSync(path.join(src, 'index.html'))) {
        throw new Error('reader/dist is missing. Run `npm run build:reader` first.');
      }
      const dest = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'assets', 'reader');
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      return cfg;
    },
  ]);
};
