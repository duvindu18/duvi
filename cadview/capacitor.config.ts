import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.cadview.viewer',
  appName: 'CADView',
  webDir: 'dist',
  // No server.url: the whole app ships inside the APK/IPA and runs with no network.
};

export default config;
