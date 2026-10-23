import DropZone from '../components/DropZone';

/**
 * Phase 0 shell (SPEC §16): renders an empty DropZone.
 * Transcript, candidates, preview and export UI arrive in later phases.
 */
export default function App() {
  return (
    <main className="app">
      <DropZone />
    </main>
  );
}
