// ============================================================
// Medical Premium Illustrator — Frontend Configuration
// ============================================================
//
// SINGLE-HOST mode (recommended — see README.md): if this page is being
// served BY the same backend server (server.js serves frontend/ as
// static files), leave this alone. It auto-detects that case and uses
// an empty string, so requests go to "/api/..." on whatever origin
// served this page — no separate backend URL to configure, and no
// CORS to get right, since it's all one origin.
//
// SPLIT mode: if the frontend is hosted separately from the backend
// (e.g. frontend on GitHub Pages, backend on Render), override the
// auto-detected value below with your backend's full URL:
//   const API_BASE_URL = 'https://medical-premium-illustrator-api.onrender.com';
//
// LOCAL FILE testing: if you open frontend/index.html directly as a
// file (double-click it, or file:// in the address bar) rather than
// through a running server, this defaults to http://localhost:3001 —
// point that at a backend you've started locally (see backend/README.md).

const API_BASE_URL = (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:')
  ? 'http://localhost:3001'
  : '';
