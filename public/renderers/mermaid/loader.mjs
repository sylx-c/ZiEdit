import mermaid from './mermaid.esm.min.mjs';
window.dispatchEvent(new CustomEvent('ZiEdit-mermaid-loaded', { detail: mermaid }));
