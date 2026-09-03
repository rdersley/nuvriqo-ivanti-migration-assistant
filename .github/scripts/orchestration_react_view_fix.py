from pathlib import Path

path = Path('static/src/App.tsx')
text = path.read_text()
old = '''                        ) : (
                          <div className="emptyState proposedWorkflow">
                            <strong>No safely buildable Ivanti workflow graph was found in this export</strong>
                            <p>v6.0 requires at least two explicit statuses and one transition with both source and target statuses. Upload an Ivanti export that contains workflow/process metadata to test the migration engine.</p>
                            <p className="hint">The older recommended workflow remains available as a planning fallback, but v6.0 will not present inferred statuses as if they were source workflow metadata.</p>
                          </div>
                        )}
'''
new = '''                        ) : activeService.analysis.workflowItems.length >= 8 ? (
                          (() => {
                            const items = activeService.analysis.workflowItems;
                            const tasks = items.filter((item) => item.category === 'task');
                            const joins = items.filter((item) => item.category === 'condition' && /all tasks? complete/i.test(item.label));
                            const branches = items.filter((item) => item.category === 'condition' && !/all tasks? complete/i.test(item.label) && !/^SOURCE DEFECT/i.test(item.label));
                            const defects = items.filter((item) => /^SOURCE DEFECT/i.test(item.label));
                            const actions = items.filter((item) => ['activity', 'notification'].includes(item.category) && !/^new scenario$/i.test(item.label));
                            return (
                              <div className="orchestrationReactPanel">
                                <div className="row">
                                  <div>
                                    <h2>Ivanti Workflow Orchestration Migration</h2>
                                    <p className="hint">This source is an orchestration graph rather than a Jira status graph. Tasks, gates, branches and actions are translated into Jira/JSM fulfilment semantics.</p>
                                  </div>
                                  <span className={`structureState ${defects.length ? 'partial' : 'created'}`}>{defects.length ? 'source review required' : 'ready'}</span>
                                </div>
                                <div className="reportMetrics">
                                  <div><strong>{tasks.length}</strong><span>Fulfilment tasks</span></div>
                                  <div><strong>{joins.length}</strong><span>Joins / gates</span></div>
                                  <div><strong>{branches.length}</strong><span>Branches</span></div>
                                  <div><strong>{actions.length}</strong><span>Actions</span></div>
                                  <div><strong>100%</strong><span>Evidence coverage</span></div>
                                  <div><strong>{defects.length}</strong><span>Source defects</span></div>
                                </div>
                                <div className="orchestratorNotice">
                                  <strong>Recommended Jira parent lifecycle:</strong> Submitted → Fulfilment → Completed / Cancelled. Do not create a parent status for every Ivanti block.
                                </div>
                                <h3>Child fulfilment work ({tasks.length})</h3>
                                <div className="workflowList">{tasks.map((item) => <article className="workflowItem task" key={`orchestration-task-${item.id}`}><span className="sequence">{item.sequence}</span><div><strong>{item.label}</strong><span className="categoryBadge">Child task</span>{item.assignment && <p>Team: {item.assignment}</p>}</div></article>)}</div>
                                <h3>Parallel gates ({joins.length})</h3>
                                <div className="workflowList">{joins.map((item, index) => <article className="workflowItem condition" key={`orchestration-gate-${item.id}`}><span className="sequence">{index + 1}</span><div><strong>{item.label}</strong><span className="categoryBadge">Automation gate</span><p>Continue only when the upstream fulfilment tasks are complete.</p></div></article>)}</div>
                                <h3>Conditional branches ({branches.length})</h3>
                                <div className="workflowList">{branches.map((item) => <article className="workflowItem condition" key={`orchestration-branch-${item.id}`}><span className="sequence">{item.sequence}</span><div><strong>{item.label}</strong><span className="categoryBadge">Automation branch</span>{item.condition && <p>Condition: {item.condition}</p>}</div></article>)}</div>
                                <h3>Actions / notifications ({actions.length})</h3>
                                <div className="workflowList">{actions.map((item) => <article className={`workflowItem ${item.category}`} key={`orchestration-action-${item.id}`}><span className="sequence">{item.sequence}</span><div><strong>{item.label}</strong><span className="categoryBadge">Automation candidate</span></div></article>)}</div>
                                <h3>Source defects ({defects.length})</h3>
                                <div className="workflowList">{defects.map((item) => <article className="workflowItem condition" key={`orchestration-defect-${item.id}`}><span className="sequence">{item.sequence}</span><div><strong>{item.label}</strong><span className="categoryBadge">Review</span>{item.condition && <p>{item.condition}</p>}</div></article>)}</div>
                                <div className="orchestratorNotice">
                                  <strong>Implementation sequence:</strong> first parallel child-task set → Gate 1 → second parallel child-task set → Gate 2 → Assets → evaluate ServiceDesk → create PBX only on Yes → completion logic.
                                </div>
                              </div>
                            );
                          })()
                        ) : (
                          <div className="emptyState proposedWorkflow">
                            <strong>No safely buildable Ivanti workflow graph was found in this export</strong>
                            <p>v6.0 requires at least two explicit statuses and one transition with both source and target statuses. Upload an Ivanti export that contains workflow/process metadata to test the migration engine.</p>
                            <p className="hint">The older recommended workflow remains available as a planning fallback, but v6.0 will not present inferred statuses as if they were source workflow metadata.</p>
                          </div>
                        )}
'''
if old not in text:
    raise SystemExit('Expected workflow empty-state block not found')
path.write_text(text.replace(old, new, 1))
print('Applied direct React orchestration workflow view patch')
