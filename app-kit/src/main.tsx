import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from './App.tsx'
import { makeQueryClient } from './lib/queryClient.ts'
import './design-tokens/kami.css'
import './styles.css'

// React Query (server state) wraps the app; jotai (UI + streaming state) uses its default
// global store, so no Provider is needed.
const queryClient = makeQueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
