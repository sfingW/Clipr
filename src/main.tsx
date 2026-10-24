import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { useAppStore } from './app/store';
import { detectTier, probeWebGpu } from './app/tiers';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Capability detection runs at startup (SPEC §11); Phase 0 returns 'basic'.
void detectTier().then((tier) => {
  useAppStore.getState().setTier(tier);
});

// WebGPU gates the AI scoring controls (SPEC §8.6, §11); the cutter never waits on it.
void probeWebGpu().then((ok) => {
  useAppStore.getState().setWebGpu(ok ? 'available' : 'unavailable');
});
