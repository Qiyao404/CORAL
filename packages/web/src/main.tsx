import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { bootstrapTheme, ThemeProvider } from './contexts/ThemeContext';

// 在 React 渲染前同步根据 localStorage / 系统偏好把 <html> 切到正确主题
bootstrapTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
