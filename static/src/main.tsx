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
import WorkflowGraphCompilerMount from './WorkflowGraphCompilerMount';
import FormRepairMount from './FormRepairMount';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <FormRepairMount />
    <IvantiConnectionMount />
    <WorkflowXmlImportMount />
    <WorkflowGetInstancePasteMount />
    <WorkflowAssociationMount />
    <WorkflowImplementationMount />
    <WorkflowGraphCompilerMount />
  </React.StrictMode>
);
