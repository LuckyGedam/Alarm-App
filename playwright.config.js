import { defineConfig } from '@playwright/test'

// The app talks to the local Firebase emulators when this env flag is set
// (see src/firebase.js and firebase.json for the ports).
const EMULATOR_ENV = {
  ...process.env,
  VITE_USE_FIREBASE_EMULATORS: 'true',
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: false,
    env: EMULATOR_ENV,
    timeout: 60_000,
  },
})