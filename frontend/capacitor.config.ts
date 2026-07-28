import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aichat.mobile',
  appName: 'AI Chat',
  webDir: 'dist',
  server: {
    // Allow cleartext HTTP for local network API calls
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    // Allow the app to access local network
    allowMixedContent: true,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
