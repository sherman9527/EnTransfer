/// <reference types="vite/client" />

import type { EnTransferApi } from '../../shared/types'

declare global {
  interface Window {
    api: EnTransferApi
  }
}

export {}
