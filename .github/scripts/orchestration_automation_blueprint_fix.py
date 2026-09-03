from pathlib import Path

path = Path('static/src/App.tsx')
text = path.read_text()
start = text.index('function automationBlueprint(service: MigrationService): AutomationBlueprintRule[] {')
end = text.index('\nfunction implementationBlueprint', start)
replacement = r'''function automationBlueprint(service: MigrationService): AutomationBlueprintRule[] {
  const workflowItems = service.analysis.workflowItems ?? [];
  const orchestrationSource = workflowItems.some((item) =>
    /all\s*tasks?\s*complete|servicedesk|source defect|active directory|office 365|harvest|assets|pbx/i.test(String(item.label ?? ''))
  );

  if (orchestrationSource) {
    const serviceName = service.analysis.serviceName;
    return [
      {
        name: `${serviceName} — initialise fulfilment`,
        trigger: 'Work item created',
        conditions: [`Request type equals "${serviceName}"`],
        actions: [
          'Keep parent request in compact Fulfilment lifecycle',
          'Create child task: Active Directory — assign First Line Support when resolvable',
          'Create child task: Office 365 — assign First Line Support when resolvable'
        ]
      },
      {
        name: `${serviceName} — Gate 1`,
        trigger: 'Child fulfilment task transitioned to Done',
        conditions: [
          'Parent request type matches New Employee Setup',
          'Active Directory child task is Done',
          'Office 365 child task is Done',
          'Second-wave tasks do not already exist'
        ],
        actions: [
          'Create child task: Firewall/VPN/Cisco VPN',
          'Create child task: Jira — assign Change Management when resolvable',
          'Create child task: Slack',
          'Create child task: Harvest',
          'Run Hiring Manager notification/update automation candidates where configured'
        ]
      },
      {
        name: `${serviceName} — Gate 2`,
        trigger: 'Child fulfilment task transitioned to Done',
        conditions: [
          'Firewall/VPN/Cisco VPN child task is Done',
          'Jira child task is Done',
          'Slack child task is Done',
          'Harvest child task is Done',
          'Assets task does not already exist'
        ],
        actions: ['Create child task: Assets']
      },
      {
        name: `${serviceName} — ServiceDesk PBX branch`,
        trigger: 'Assets child task transitioned to Done',
        conditions: ['ServiceDesk / isServiceDesk equals Yes', 'PBX task does not already exist'],
        actions: ['Create child task: PBX']
      },
      {
        name: `${serviceName} — complete without PBX`,
        trigger: 'Assets child task transitioned to Done',
        conditions: [
          'ServiceDesk / isServiceDesk does not equal Yes',
          'All required non-PBX child fulfilment tasks are Done'
        ],
        actions: ['Transition parent request to Completed']
      },
      {
        name: `${serviceName} — complete after PBX`,
        trigger: 'PBX child task transitioned to Done',
        conditions: ['All required child fulfilment tasks are Done'],
        actions: ['Transition parent request to Completed']
      },
      {
        name: `${serviceName} — source defect review`,
        trigger: 'Migration implementation review',
        conditions: ['Ivanti source contains the unnamed Quick Action with an unconnected ok exit'],
        actions: ['Do not recreate the broken Quick Action automatically', 'Require explicit review before adding replacement behaviour']
      }
    ];
  }

  const rules: AutomationBlueprintRule[] = [];
  const tasks = service.analysis.suggestedWorkflow.taskNames;

  rules.push({
    name: `${service.analysis.serviceName} — initialise request`,
    trigger: 'Work item created',
    conditions: [`Request type equals "${service.analysis.serviceName}"`],
    actions: ['Transition parent request to Provisioning', 'Add migration label']
  });

  if (tasks.length) {
    rules.push({
      name: `${service.analysis.serviceName} — create fulfilment tasks`,
      trigger: 'Parent enters Provisioning',
      conditions: [`Request type equals "${service.analysis.serviceName}"`],
      actions: tasks.map((task) => `Create subtask: ${task}`)
    });
  }

  service.proposedConditions.forEach((condition) => {
    const controller = service.analysis.fields.find((field) => field.id === condition.controllerFieldId);
    const targets = condition.targetFieldIds
      .map((id) => service.analysis.fields.find((field) => field.id === id)?.name)
      .filter(Boolean);
    if (!controller || !targets.length) return;
    rules.push({
      name: `${service.analysis.serviceName} — ${controller.name} condition`,
      trigger: 'Request created or updated',
      conditions: [`${controller.name} equals ${condition.value}`],
      actions: [`Use values for: ${targets.join(', ')}`]
    });
  });

  rules.push({
    name: `${service.analysis.serviceName} — complete parent`,
    trigger: 'Subtask transitioned to Done',
    conditions: ['All sibling subtasks are in Done status category'],
    actions: ['Transition parent request to Completed']
  });

  return rules;
}
'''
path.write_text(text[:start] + replacement + text[end:])
print('Applied orchestration-aware automation blueprint patch')
