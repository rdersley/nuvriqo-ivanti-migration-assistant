from pathlib import Path

path = Path('static/src/App.tsx')
text = path.read_text()
needle = '''                                <div className="orchestratorNotice">
                                  <strong>Implementation sequence:</strong> first parallel child-task set → Gate 1 → second parallel child-task set → Gate 2 → Assets → evaluate ServiceDesk → create PBX only on Yes → completion logic.
                                </div>
'''
replacement = '''                                <div className="orchestratorNotice">
                                  <strong>Implementation sequence:</strong> first parallel child-task set → Gate 1 → second parallel child-task set → Gate 2 → Assets → evaluate ServiceDesk → create PBX only on Yes → completion logic.
                                </div>
                                <div className="projectBuildActions">
                                  <article className="buildCard ready">
                                    <div><strong>Jira execution model</strong><p>Parent request stays compact. The recovered Ivanti tasks become linked fulfilment work driven by automation gates and branches.</p></div>
                                    <span className="structureState created">ready</span>
                                  </article>
                                </div>
                                <h3>Jira execution plan</h3>
                                <div className="workflowList">
                                  <article className="workflowItem task"><span className="sequence">1</span><div><strong>Create first fulfilment wave</strong><span className="categoryBadge">Create child work</span><p>Active Directory + Office 365. Preserve source team assignment where Jira can resolve it.</p></div></article>
                                  <article className="workflowItem condition"><span className="sequence">2</span><div><strong>Gate 1</strong><span className="categoryBadge">Wait condition</span><p>Continue only when the first-wave child work is complete; notification/update actions remain automation candidates.</p></div></article>
                                  <article className="workflowItem task"><span className="sequence">3</span><div><strong>Create second fulfilment wave</strong><span className="categoryBadge">Create child work</span><p>Firewall/VPN/Cisco VPN + Jira + Slack + Harvest.</p></div></article>
                                  <article className="workflowItem condition"><span className="sequence">4</span><div><strong>Gate 2</strong><span className="categoryBadge">Wait condition</span><p>Continue only when all second-wave child work is complete.</p></div></article>
                                  <article className="workflowItem task"><span className="sequence">5</span><div><strong>Create Assets work</strong><span className="categoryBadge">Create child work</span><p>Create the Assets fulfilment task after Gate 2.</p></div></article>
                                  <article className="workflowItem condition"><span className="sequence">6</span><div><strong>Evaluate ServiceDesk</strong><span className="categoryBadge">Branch</span><p>When isServiceDesk = Yes, create PBX fulfilment work. Otherwise skip PBX.</p></div></article>
                                  <article className="workflowItem task"><span className="sequence">7</span><div><strong>Complete parent request</strong><span className="categoryBadge">Completion</span><p>Complete only after required child work is finished. The broken unnamed Ivanti Quick Action is excluded until reviewed.</p></div></article>
                                </div>
                                <div className="orchestratorNotice">
                                  <strong>Safety boundary:</strong> the app will not invent the broken Quick Action or convert Ivanti joins into Jira statuses. Atlassian Automation API restrictions mean the app produces the exact automation implementation definition for review rather than claiming unsupported direct rule creation.
                                </div>
'''
if needle not in text:
    raise SystemExit('Expected orchestration implementation sequence not found')
path.write_text(text.replace(needle, replacement, 1))
print('Applied Jira orchestration execution-plan patch')
