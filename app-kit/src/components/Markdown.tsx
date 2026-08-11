import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  // Links open in a new tab.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // Wrap tables so wide ones scroll horizontally inside the bubble instead of overflowing.
  table: ({ children }) => (
    <div className="table-scroll">
      <table>{children}</table>
    </div>
  ),
}

/** Render assistant text as Markdown (GFM: tables / strikethrough / task lists / autolinks).
 *  rehype-raw is intentionally NOT enabled → raw HTML in model output is not rendered (XSS-safe). */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
