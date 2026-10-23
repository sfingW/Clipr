/**
 * Full-screen drop target (SPEC §3, §16 Phase 1 = file drop → OPFS write).
 * A plain `<input type="file">` also accepts drops natively; we still wire the
 * container drag events so a drop anywhere on screen works and the browser
 * never navigates away to the dropped file.
 */
import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';

export interface DropZoneProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

export default function DropZone({ onFiles, disabled }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (list: FileList | null): void => {
    if (disabled || !list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    take(e.dataTransfer?.files ?? null);
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    take(e.target.files);
    e.target.value = ''; // allow re-picking the same file after an error
  };

  return (
    <div
      className={`dropzone${over ? ' dropzone--over' : ''}${disabled ? ' dropzone--disabled' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      data-testid="dropzone"
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.m4v,.mov"
        onChange={onChange}
        disabled={disabled}
        aria-label="Choose a video file"
      />
      <div className="dropzone__inner">
        <h1 className="dropzone__title">Clipr</h1>
        <p className="dropzone__hint">
          Drop an <strong>MP4</strong> — decoding, cutting and export all run inside this tab.
          Nothing is uploaded.
        </p>
        <button type="button" className="btn btn--primary" disabled={disabled}>
          {disabled ? 'Working…' : 'Choose file'}
        </button>
      </div>
    </div>
  );
}
