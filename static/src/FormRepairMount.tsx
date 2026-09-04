import { useEffect, useRef, useState } from 'react';
import { invoke } from '@forge/bridge';

const PROJECT_KEY = 'ivanti-migration-assistant-project-v3';
const REPAIR_KEY = 'ivanti-migration-assistant-form-repair-v3';

type RepairResult = {
  matchedForms: number;
  changedForms: number;
  results: Array<{ name: string; repairedLookups: string[]; hiddenHelpers: string[]; changed: boolean }>;
};

export default function FormRepairMount() {
  const started = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    try {
      const raw = localStorage.getItem(PROJECT_KEY);
      if (!raw) return;
      const project = JSON.parse(raw) as { targetProjectId?: string; services?: Array<{ analysis?: { serviceName?: string } }> };
      const projectId = String(project.targetProjectId ?? '').trim();
      const serviceNames = (project.services ?? []).map((service) => String(service.analysis?.serviceName ?? '').trim()).filter(Boolean);
      if (!projectId || !serviceNames.length) return;

      const fingerprint = `${projectId}|${serviceNames.sort().join('|')}|v3`;
      if (localStorage.getItem(REPAIR_KEY) === fingerprint) return;

      setMessage('Repairing existing migrated Jira Forms…');
      invoke('repairMigratedForms', { projectId, serviceNames })
        .then((rawResult) => {
          const result = rawResult as RepairResult;
          localStorage.setItem(REPAIR_KEY, fingerprint);
          const lookupCount = (result.results ?? []).reduce((sum, item) => sum + (item.repairedLookups?.length ?? 0), 0);
          const helperCount = (result.results ?? []).reduce((sum, item) => sum + (item.hiddenHelpers?.length ?? 0), 0);
          setMessage(
            result.changedForms
              ? `Form repair complete: ${result.changedForms} form(s) corrected, ${lookupCount} lookup field(s) made fillable and ${helperCount} helper field(s) removed from the customer form.`
              : `Form repair check complete: ${result.matchedForms} migrated form(s) checked; no further changes were required.`
          );
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
          setMessage('');
        });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  if (!message && !error) return null;
  return (
    <section style={{ margin: '16px 24px', padding: 16, border: '1px solid #dfe1e6', borderRadius: 8, background: '#fff' }}>
      <strong>Existing form repair</strong>
      <div style={{ marginTop: 6 }}>{error ? `Repair needs attention: ${error}` : message}</div>
    </section>
  );
}
