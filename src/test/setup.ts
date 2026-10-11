import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { configureRelay } from '@/lib/workspace'

/**
 * Keep local configuration out of the suite.
 *
 * Vite loads `.env.local` for tests as well as for `pnpm dev`, so a developer
 * with a relay URL set would otherwise switch encrypted sync on mid-suite and
 * open a real socket to it - passing or failing depending on whose machine it
 * ran on. A test that wants it on configures it on, explicitly.
 */
configureRelay({ url: null })
