import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme } from './ui/theme';
import './styles.css';

// React kurulmadan önce: koyu tema seçiliyken beyaz ekran parlamasını önler.
initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
