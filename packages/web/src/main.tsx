import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { loadTheme } from './prefs.js';
import './styles.css';
import { applyTheme } from './theme.js';

// Before the first render, so a dark viewer never sees a light flash.
applyTheme(loadTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
