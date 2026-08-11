import { useEffect } from 'react'

/** Full-image overlay for a clicked bubble thumbnail (the `large` rendition). Click anywhere or
 *  press Esc to close. Kept dependency-free — a fixed overlay, no portal needed. */
export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <img src={src} alt="" />
    </div>
  )
}
