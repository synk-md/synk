import { defineConfig, devices } from "@playwright/test"

/**
 * Two real browsers against the real stack: signaling, the relay and the app,
 * each on its own port so a test run never touches a dev session.
 */

const SIGNALING_PORT = 4544
const RELAY_PORT = 4555
const APP_PORT = 4173

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  // One stack shared by every test, and each test is two people talking to it.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${String(APP_PORT)}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "node_modules/.bin/y-webrtc-signaling",
      env: { PORT: String(SIGNALING_PORT) },
      port: SIGNALING_PORT,
      reuseExistingServer: false,
    },
    {
      command: "pnpm relay",
      env: { RELAY_PORT: String(RELAY_PORT) },
      url: `http://localhost:${String(RELAY_PORT)}/health`,
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec vite --port ${String(APP_PORT)} --strictPort`,
      // Set in the environment, which Vite ranks above any .env file.
      env: {
        VITE_SYNK_RELAY_URL: `ws://localhost:${String(RELAY_PORT)}`,
        VITE_LOCAL_SIGNALING_URL: `ws://localhost:${String(SIGNALING_PORT)}`,
      },
      url: `http://localhost:${String(APP_PORT)}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
