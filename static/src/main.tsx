import React from 'react';
import ReactDOM from 'react-dom/client';
import './orchestrationWorkflowView';
import './workflowInstanceCompat';
import './workflowSemanticCleanup';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
