import React from 'react';
import ReactDOM from 'react-dom/client';
import './orchestrationWorkflowView';
import './orchestrationSavedEvidenceView';
import './workflowInstanceCompat';
import './workflowSemanticCleanup';
import './safeOrchestrationBuild';
import App from './App';
import IvantiConnectionMount from './IvantiConnectionMount';
import WorkflowXmlImportMount from './WorkflowXmlImportMount';
import WorkflowGetInstancePasteMount from './WorkflowGetInstancePasteMount';
import WorkflowAssociationMount from './WorkflowAssociationMount';
import WorkflowImplementationMount from './WorkflowImplementationMount';
import FullMigrationRunnerMount from './FullMigrationRunnerMount';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <IvantiConnectionMount />
    <WorkflowXmlImportMount />
    <WorkflowGetInstancePasteMount />
    <WorkflowAssociationMount />
    <WorkflowImplementationMount />
    <FullMigrationRunnerMount />
  </React.StrictMode>
);