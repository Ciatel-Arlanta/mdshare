// The default Gradle heap (2 GB, 512 MB metaspace) runs out while compiling
// this app's native modules. Give the Gradle and Kotlin daemons more room.
const { withGradleProperties } = require('expo/config-plugins');

const JVM_ARGS = '-Xmx4096m -XX:MaxMetaspaceSize=1536m -Dfile.encoding=UTF-8';

module.exports = function withGradleMemory(config) {
  return withGradleProperties(config, (cfg) => {
    const set = (key, value) => {
      const existing = cfg.modResults.find((p) => p.type === 'property' && p.key === key);
      if (existing) existing.value = value;
      else cfg.modResults.push({ type: 'property', key, value });
    };
    set('org.gradle.jvmargs', JVM_ARGS);
    set('kotlin.daemon.jvmargs', '-Xmx2048m -XX:MaxMetaspaceSize=1024m');
    return cfg;
  });
};
