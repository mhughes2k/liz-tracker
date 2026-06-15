/**
 * Tracker DB unit tests
 *
 * Uses the in-memory database via _initTestTrackerDatabase() so tests are:
 * - Fast (no disk I/O)
 * - Isolated (fresh DB per describe block via beforeEach)
 * - Safe (never touch the live tracker.db)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestTrackerDatabase,
  classifyActor,
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  createWorkItem,
  getWorkItem,
  getWorkItemKey,
  listWorkItems,
  changeWorkItemState,
  lockWorkItem,
  unlockWorkItem,
  clearStaleLocks,
  addDependency,
  removeDependency,
  isBlocked,
  getBlockers,
  addLink,
  removeLink,
  removeLinkById,
  listLinks,
  getLinksAmongItems,
  extractMentionKeys,
  reconcileMentionLinks,
  VALID_LINK_RELATIONS,
  wouldCreateParentCycle,
  reorderChildren,
  getChildItems,
  getParentItem,
  getChildCountsBatch,
  createGroupFromItems,
  mergeItems,
  splitItem,
  bulkUpdate,
  createComment,
  createExecutionAudit,
  completeExecutionAudit,
  countExecutionAuditsWithTranscript,
  getSessionCountsBatch,
  deleteComment,
  updateComment,
  listComments,
  listTransitions,
  updateWorkItem,
  moveWorkItem,
  getDispatchableItems,
  getClarifiableItems,
  createDescriptionVersion,
  listDescriptionVersions,
  getDescriptionVersion,
  revertToDescriptionVersion,
  sanitizeCommentBody,
  logActivity,
  listActivity,
  createAttachment,
  deleteAttachment,
  deleteWorkItem,
  toggleReaction,
  getReactions,
  getReactionsBatch,
  getSetting,
  setSetting,
  getAllSettings,
  createProposal,
  getProposal,
  getProposalActions,
  listProposals,
  setProposalActionStatus,
  rejectProposal,
  applyProposal,
  expireOverdueProposals,
  getProposalStats,
  _setProposalExpiresAtForTest,
  VALID_STATES,
  VALID_PRIORITIES,
} from './db.js';
import { OWNER_NAME } from './config.js';

// ── classifyActor ──────────────────────────────────────────────────────────────

describe('classifyActor', () => {
  it('classifies human actors', () => {
    expect(classifyActor('dashboard')).toBe('human');
    expect(classifyActor('Dashboard')).toBe('human');
    expect(classifyActor('me')).toBe('human');
  });

  it('classifies agent actors', () => {
    expect(classifyActor('Coder')).toBe('agent');
    expect(classifyActor('claude')).toBe('agent');
    expect(classifyActor('agent')).toBe('agent');
    expect(classifyActor('opencode')).toBe('agent');
    expect(classifyActor('coder')).toBe('agent');
    expect(classifyActor('Harmoni')).toBe('agent');
    expect(classifyActor('harmoni')).toBe('agent');
    expect(classifyActor('HARMONI')).toBe('agent');
  });

  it('classifies system actors', () => {
    expect(classifyActor('orchestrator')).toBe('system');
    expect(classifyActor('system')).toBe('system');
    expect(classifyActor('health-check')).toBe('system');
    expect(classifyActor('scheduler')).toBe('system');
  });

  it('classifies unknown actors as api (conservative default)', () => {
    expect(classifyActor('api')).toBe('api');
    expect(classifyActor('anonymous')).toBe('api');
    expect(classifyActor('unknown-bot')).toBe('api');
    expect(classifyActor('')).toBe('api');
  });

  it('classification is case-insensitive', () => {
    expect(classifyActor('DASHBOARD')).toBe('human');
    expect(classifyActor('CLAUDE')).toBe('agent');
    expect(classifyActor('ORCHESTRATOR')).toBe('system');
  });
});

// ── Project CRUD ───────────────────────────────────────────────────────────────

describe('Project CRUD', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it('creates a project with auto-derived short_name', () => {
    const p = createProject({ name: 'Liz Development' });
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('Liz Development');
    expect(p.short_name).toBe('LIZ');
    expect(p.description).toBe('');
    expect(p.next_seq).toBe(1);
  });

  it('creates a project with explicit short_name', () => {
    const p = createProject({ name: 'My Project', short_name: 'MP' });
    expect(p.short_name).toBe('MP');
  });

  it('short_name is always uppercased', () => {
    const p = createProject({ name: 'Test', short_name: 'lower' });
    expect(p.short_name).toBe('LOWER');
  });

  it('gets a project by id', () => {
    const created = createProject({ name: 'Test Project' });
    const fetched = getProject(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe('Test Project');
  });

  it('returns undefined for non-existent project', () => {
    expect(getProject('nonexistent')).toBeUndefined();
  });

  it('lists all projects', () => {
    createProject({ name: 'Alpha' });
    createProject({ name: 'Beta' });
    const projects = listProjects();
    expect(projects.length).toBe(2);
  });

  it('updates a project', () => {
    const p = createProject({ name: 'Old Name' });
    const updated = updateProject(p.id, { name: 'New Name', description: 'Updated' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('New Name');
    expect(updated!.description).toBe('Updated');
  });

  it('returns undefined when updating non-existent project', () => {
    expect(updateProject('nonexistent', { name: 'New' })).toBeUndefined();
  });

  it('deletes a project and its work items', () => {
    const p = createProject({ name: 'To Delete' });
    createWorkItem({ project_id: p.id, title: 'Child Item' });
    expect(deleteProject(p.id)).toBe(true);
    expect(getProject(p.id)).toBeUndefined();
    expect(listWorkItems({ project_id: p.id })).toHaveLength(0);
  });

  it('returns false when deleting non-existent project', () => {
    expect(deleteProject('nonexistent')).toBe(false);
  });

  it('tab_order increments across multiple projects', () => {
    const p1 = createProject({ name: 'First' });
    const p2 = createProject({ name: 'Second' });
    const p3 = createProject({ name: 'Third' });
    expect(p1.tab_order).toBeLessThan(p2.tab_order);
    expect(p2.tab_order).toBeLessThan(p3.tab_order);
  });
});

// ── Project opencode_project_id ────────────────────────────────────────────────

describe('Project opencode_project_id', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it('defaults opencode_project_id to empty string', () => {
    const p = createProject({ name: 'Test' });
    expect(p.opencode_project_id).toBe('');
  });

  it('creates project with explicit opencode_project_id', () => {
    const p = createProject({
      name: 'With OC ID',
      opencode_project_id: 'oc-proj-abc123',
    });
    expect(p.opencode_project_id).toBe('oc-proj-abc123');
  });

  it('updates opencode_project_id', () => {
    const p = createProject({ name: 'Test' });
    expect(p.opencode_project_id).toBe('');

    const updated = updateProject(p.id, { opencode_project_id: 'oc-proj-xyz789' });
    expect(updated).toBeDefined();
    expect(updated!.opencode_project_id).toBe('oc-proj-xyz789');
  });

  it('preserves opencode_project_id when updating other fields', () => {
    const p = createProject({
      name: 'Test',
      opencode_project_id: 'oc-proj-keep-me',
    });

    const updated = updateProject(p.id, { name: 'New Name' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('New Name');
    expect(updated!.opencode_project_id).toBe('oc-proj-keep-me');
  });

  it('getProject returns opencode_project_id', () => {
    const p = createProject({
      name: 'Test',
      opencode_project_id: 'oc-proj-read-test',
    });
    const fetched = getProject(p.id);
    expect(fetched).toBeDefined();
    expect(fetched!.opencode_project_id).toBe('oc-proj-read-test');
  });

  it('can clear opencode_project_id by setting to empty string', () => {
    const p = createProject({
      name: 'Test',
      opencode_project_id: 'oc-proj-to-clear',
    });
    const updated = updateProject(p.id, { opencode_project_id: '' });
    expect(updated).toBeDefined();
    expect(updated!.opencode_project_id).toBe('');
  });
});

// ── Work Item CRUD ─────────────────────────────────────────────────────────────

describe('Work Item CRUD', () => {
  let projectId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test Project' });
    projectId = p.id;
  });

  it('creates a work item with defaults', () => {
    const item = createWorkItem({ project_id: projectId, title: 'My Task' });
    expect(item.id).toBeTruthy();
    expect(item.title).toBe('My Task');
    expect(item.state).toBe('brainstorming');
    expect(item.priority).toBe('none');
    expect(item.labels).toBe('[]');
    expect(item.requires_code).toBe(0);
    expect(item.platform).toBe('any');
  });

  it('allocates sequential seq_numbers', () => {
    const i1 = createWorkItem({ project_id: projectId, title: 'First' });
    const i2 = createWorkItem({ project_id: projectId, title: 'Second' });
    const i3 = createWorkItem({ project_id: projectId, title: 'Third' });
    expect(i1.seq_number).toBe(1);
    expect(i2.seq_number).toBe(2);
    expect(i3.seq_number).toBe(3);
  });

  it('generates correct work item key', () => {
    const p = createProject({ name: 'Liz', short_name: 'LIZ' });
    const item = createWorkItem({ project_id: p.id, title: 'First Issue' });
    expect(getWorkItemKey(item)).toBe('LIZ-1');
  });

  it('gets a work item by id', () => {
    const created = createWorkItem({ project_id: projectId, title: 'Task' });
    const fetched = getWorkItem(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
  });

  it('returns undefined for non-existent work item', () => {
    expect(getWorkItem('nonexistent')).toBeUndefined();
  });

  it('lists work items with project filter', () => {
    const p2 = createProject({ name: 'Other Project' });
    createWorkItem({ project_id: projectId, title: 'Item 1' });
    createWorkItem({ project_id: projectId, title: 'Item 2' });
    createWorkItem({ project_id: p2.id, title: 'Other' });
    const items = listWorkItems({ project_id: projectId });
    expect(items).toHaveLength(2);
  });

  it('lists work items with state filter', () => {
    createWorkItem({ project_id: projectId, title: 'Brainstorming', state: 'brainstorming' });
    createWorkItem({ project_id: projectId, title: 'Approved', state: 'approved', created_by: 'dashboard' });
    const brainstorming = listWorkItems({ project_id: projectId, state: 'brainstorming' });
    expect(brainstorming).toHaveLength(1);
    expect(brainstorming[0].title).toBe('Brainstorming');
  });

  it('records initial transition on create', () => {
    const item = createWorkItem({ project_id: projectId, title: 'New Item' });
    const transitions = listTransitions(item.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from_state).toBeNull();
    expect(transitions[0].to_state).toBe('brainstorming');
    expect(transitions[0].comment).toBe('Created');
  });

  it('classifies created_by_class correctly', () => {
    const humanItem = createWorkItem({ project_id: projectId, title: 'Human', created_by: 'dashboard' });
    const agentItem = createWorkItem({ project_id: projectId, title: 'Agent', created_by: 'Coder' });
    expect(humanItem.created_by_class).toBe('human');
    expect(agentItem.created_by_class).toBe('agent');
  });

  it('classifies Harmoni as agent (TRACK-213)', () => {
    const item = createWorkItem({ project_id: projectId, title: 'Harmoni item', created_by: 'Harmoni' });
    expect(item.created_by).toBe('Harmoni');
    expect(item.created_by_class).toBe('agent');
  });
});

// ── State Transitions ──────────────────────────────────────────────────────────

describe('State Transitions', () => {
  let projectId: string;
  let itemId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test' });
    projectId = p.id;
    const item = createWorkItem({ project_id: projectId, title: 'Task' });
    itemId = item.id;
  });

  it('changes state successfully', () => {
    const updated = changeWorkItemState(itemId, 'clarification', 'dashboard');
    expect(updated).toBeDefined();
    expect(updated!.state).toBe('clarification');
  });

  it('records transitions in history', () => {
    changeWorkItemState(itemId, 'clarification', 'dashboard');
    changeWorkItemState(itemId, 'approved', 'dashboard');
    const transitions = listTransitions(itemId);
    // Initial "Created" + 2 state changes
    expect(transitions).toHaveLength(3);
    expect(transitions[1].from_state).toBe('brainstorming');
    expect(transitions[1].to_state).toBe('clarification');
    expect(transitions[2].from_state).toBe('clarification');
    expect(transitions[2].to_state).toBe('approved');
  });

  it('returns existing item if state unchanged (no-op)', () => {
    const original = getWorkItem(itemId)!;
    const result = changeWorkItemState(itemId, 'brainstorming', 'dashboard');
    expect(result!.state).toBe('brainstorming');
    // Should not add a new transition
    const transitions = listTransitions(itemId);
    expect(transitions).toHaveLength(1); // only the initial "Created"
  });

  it('returns undefined for non-existent item', () => {
    expect(changeWorkItemState('nonexistent', 'approved', 'dashboard')).toBeUndefined();
  });

  it('SECURITY: only human actors can approve code items', () => {
    // Create a requires_code item — agents must NOT be able to approve these
    const codeItem = createWorkItem({
      project_id: projectId,
      title: 'Code task',
      requires_code: true,
    });
    expect(() => changeWorkItemState(codeItem.id, 'approved', 'Coder')).toThrow(
      /Only human actors can approve/
    );
    expect(() => changeWorkItemState(codeItem.id, 'approved', 'orchestrator')).toThrow(
      /Only human actors can approve/
    );
    expect(() => changeWorkItemState(codeItem.id, 'approved', 'api-user')).toThrow(
      /Only human actors can approve/
    );
  });

  it('SECURITY: human actors CAN approve items', () => {
    expect(() => changeWorkItemState(itemId, 'approved', 'dashboard')).not.toThrow();
  });

  it('SECURITY: agents CAN approve comment-only items', () => {
    // Comment-only items (requires_code=0) can be approved by agents since
    // they don't present a security risk (no code changes)
    const commentItem = createWorkItem({
      project_id: projectId,
      title: 'Comment only task',
      requires_code: false,
      bot_dispatch: true,
    });
    expect(() => changeWorkItemState(commentItem.id, 'approved', 'Coder')).not.toThrow();
    const updated = getWorkItem(commentItem.id)!;
    expect(updated.state).toBe('approved');
    expect(updated.approved_by).toBe('Coder');
    expect(updated.approved_by_class).toBe('agent');
    expect(updated.approved_description_hash).toBeTruthy();
  });

  it('SECURITY: system actors CAN recycle scheduled tasks back to approved (TRACK-228)', () => {
    // Create a scheduled task with requires_code
    const scheduledItem = createWorkItem({
      project_id: projectId,
      title: 'Daily cleanup task',
      requires_code: true,
      bot_dispatch: true,
      space_type: 'scheduled',
      space_data: JSON.stringify({
        schedule: { frequency: 'daily', time: '07:00', timezone: 'Australia/Perth' },
        status: { run_count: 0 },
        todo: ['Clean temp files'],
        ignore: [],
      }),
    });

    // Human approves it first (establishes approval provenance)
    changeWorkItemState(scheduledItem.id, 'approved', 'dashboard');
    const approved = getWorkItem(scheduledItem.id)!;
    expect(approved.approved_by).toBe('dashboard');
    expect(approved.approved_by_class).toBe('human');
    expect(approved.approved_description_hash).toBeTruthy();

    // Move through the lifecycle: approved → in_development → in_review
    changeWorkItemState(scheduledItem.id, 'in_development', 'Coder');
    changeWorkItemState(scheduledItem.id, 'in_review', 'Coder');

    // Orchestrator (system actor) recycles back to approved — should succeed
    expect(() => changeWorkItemState(scheduledItem.id, 'approved', 'orchestrator')).not.toThrow();
    const recycled = getWorkItem(scheduledItem.id)!;
    expect(recycled.state).toBe('approved');
    // Original human approval provenance preserved
    expect(recycled.approved_by).toBe('dashboard');
    expect(recycled.approved_by_class).toBe('human');
    expect(recycled.approved_description_hash).toBeTruthy();
  });

  it('SECURITY: system actors CANNOT recycle non-scheduled tasks to approved', () => {
    // Regular code item — system actors must NOT be able to approve
    const codeItem = createWorkItem({
      project_id: projectId,
      title: 'Regular code task',
      requires_code: true,
    });
    expect(() => changeWorkItemState(codeItem.id, 'approved', 'orchestrator')).toThrow(
      /Only human actors can approve/
    );
  });

  it('SECURITY: system actors CANNOT recycle scheduled tasks without human approval provenance', () => {
    // Scheduled task that was never human-approved
    const scheduledItem = createWorkItem({
      project_id: projectId,
      title: 'Unapproved scheduled task',
      requires_code: true,
      space_type: 'scheduled',
      space_data: JSON.stringify({
        schedule: { frequency: 'daily' },
        status: {},
        todo: [],
        ignore: [],
      }),
    });
    // No human approval — orchestrator should not be able to approve
    expect(() => changeWorkItemState(scheduledItem.id, 'approved', 'orchestrator')).toThrow(
      /Only human actors can approve/
    );
  });

  it('SECURITY: system actors CANNOT recycle scheduled tasks with tampered descriptions', () => {
    // Create and human-approve a scheduled task
    const scheduledItem = createWorkItem({
      project_id: projectId,
      title: 'Scheduled task with tamper test',
      description: 'Original description',
      requires_code: true,
      space_type: 'scheduled',
      space_data: JSON.stringify({
        schedule: { frequency: 'daily' },
        status: {},
        todo: [],
        ignore: [],
      }),
    });
    changeWorkItemState(scheduledItem.id, 'approved', 'dashboard');

    // Move through lifecycle
    changeWorkItemState(scheduledItem.id, 'in_development', 'Coder');
    changeWorkItemState(scheduledItem.id, 'in_review', 'Coder');

    // Tamper with the description
    updateWorkItem(scheduledItem.id, { description: 'TAMPERED description' });

    // Orchestrator should NOT be able to recycle — description hash mismatch
    expect(() => changeWorkItemState(scheduledItem.id, 'approved', 'orchestrator')).toThrow(
      /Only human actors can approve/
    );
  });

  it('SECURITY: only human actors can cancel items', () => {
    expect(() => changeWorkItemState(itemId, 'cancelled', 'Coder')).toThrow(
      /Only human actors can cancel/
    );
  });

  it('SECURITY: human actors CAN cancel items', () => {
    expect(() => changeWorkItemState(itemId, 'cancelled', 'dashboard')).not.toThrow();
  });

  it('SECURITY: API actors cannot move items to in_development', () => {
    expect(() => changeWorkItemState(itemId, 'in_development', 'api-caller')).toThrow(
      /API actors cannot move items to in_development/
    );
  });

  it('agent actors can move items to in_development', () => {
    const result = changeWorkItemState(itemId, 'in_development', 'Coder');
    expect(result!.state).toBe('in_development');
  });

  it('records approval provenance when approved', () => {
    changeWorkItemState(itemId, 'approved', 'dashboard', 'Looks good');
    const item = getWorkItem(itemId)!;
    expect(item.approved_by).toBe('dashboard');
    expect(item.approved_by_class).toBe('human');
    expect(item.approved_at).toBeTruthy();
    expect(item.approved_description_hash).toBeTruthy();
    expect(item.approved_description_hash).toHaveLength(64); // SHA-256 hex
  });

  it('clears approval metadata when moved out of approved', () => {
    changeWorkItemState(itemId, 'approved', 'dashboard');
    changeWorkItemState(itemId, 'clarification', 'dashboard');
    const item = getWorkItem(itemId)!;
    expect(item.approved_by).toBeNull();
    expect(item.approved_by_class).toBeNull();
    expect(item.approved_at).toBeNull();
    expect(item.approved_description_hash).toBeNull();
  });

  it('assigns to actor when moved to in_development by agent', () => {
    changeWorkItemState(itemId, 'in_development', 'Coder');
    const item = getWorkItem(itemId)!;
    expect(item.assignee).toBe('Coder');
  });

  it('assigns to actor when moved to in_development by human', () => {
    changeWorkItemState(itemId, 'in_development', 'dashboard');
    const item = getWorkItem(itemId)!;
    expect(item.assignee).toBe(OWNER_NAME);
  });

  it('assigns to actor when moved to needs_input', () => {
    changeWorkItemState(itemId, 'in_development', 'Coder');
    changeWorkItemState(itemId, 'needs_input', 'Coder');
    const item = getWorkItem(itemId)!;
    expect(item.assignee).toBe(OWNER_NAME);
  });

  it('assigns to actor when moved to testing', () => {
    changeWorkItemState(itemId, 'in_development', 'Coder');
    changeWorkItemState(itemId, 'testing', 'Coder');
    const item = getWorkItem(itemId)!;
    expect(item.assignee).toBe(OWNER_NAME);
  });

  it('records comment with transition', () => {
    changeWorkItemState(itemId, 'clarification', 'dashboard', 'Needs more details');
    const transitions = listTransitions(itemId);
    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition.comment).toBe('Needs more details');
  });

  it('records actor_class with transition', () => {
    changeWorkItemState(itemId, 'in_development', 'Coder');
    const transitions = listTransitions(itemId);
    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition.actor_class).toBe('agent');
  });
});

// ── Lock / Unlock ──────────────────────────────────────────────────────────────

describe('Lock / Unlock', () => {
  let projectId: string;
  let itemId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test' });
    projectId = p.id;
    const item = createWorkItem({ project_id: projectId, title: 'Task' });
    itemId = item.id;
  });

  it('locks a work item', () => {
    const locked = lockWorkItem(itemId, 'Coder');
    expect(locked).toBeDefined();
    expect(locked!.locked_by).toBe('Coder');
    expect(locked!.locked_at).toBeTruthy();
  });

  it('unlocks a work item', () => {
    lockWorkItem(itemId, 'Coder');
    const unlocked = unlockWorkItem(itemId);
    expect(unlocked).toBeDefined();
    expect(unlocked!.locked_by).toBeNull();
    expect(unlocked!.locked_at).toBeNull();
  });

  it('returns undefined when locking non-existent item', () => {
    expect(lockWorkItem('nonexistent', 'Coder')).toBeUndefined();
  });

  it('returns undefined when unlocking non-existent item', () => {
    expect(unlockWorkItem('nonexistent')).toBeUndefined();
  });

  it('clearStaleLocks clears expired locks and adds comment', () => {
    // Lock the item
    lockWorkItem(itemId, 'Coder');

    // Use a negative maxAge so the cutoff is in the future (all locks appear stale)
    // clearStaleLocks(-60000) → cutoff = now + 60s → any locked_at < that is "stale"
    const cleared = clearStaleLocks(-60000);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].id).toBe(itemId);

    // Item should now be unlocked
    const item = getWorkItem(itemId)!;
    expect(item.locked_by).toBeNull();

    // Comment should be added
    const comments = listComments(itemId);
    expect(comments.some(c => c.body.includes('Lock expired'))).toBe(true);
  });

  it('clearStaleLocks does not clear fresh locks', () => {
    lockWorkItem(itemId, 'Coder');
    const cleared = clearStaleLocks(2 * 60 * 60 * 1000); // 2 hours (standard)
    expect(cleared).toHaveLength(0);

    const item = getWorkItem(itemId)!;
    expect(item.locked_by).toBe('Coder');
  });
});

// ── Dependencies ───────────────────────────────────────────────────────────────

describe('Dependencies', () => {
  let projectId: string;
  let itemA: string;
  let itemB: string;
  let itemC: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test' });
    projectId = p.id;
    itemA = createWorkItem({ project_id: projectId, title: 'A' }).id;
    itemB = createWorkItem({ project_id: projectId, title: 'B' }).id;
    itemC = createWorkItem({ project_id: projectId, title: 'C' }).id;
  });

  it('adds a dependency', () => {
    const dep = addDependency(itemA, itemB); // A is blocked by B
    expect(dep.work_item_id).toBe(itemA);
    expect(dep.depends_on_id).toBe(itemB);
  });

  it('isBlocked returns true when blocked by non-done item', () => {
    addDependency(itemA, itemB);
    expect(isBlocked(itemA)).toBe(true);
  });

  it('isBlocked returns false when not blocked', () => {
    expect(isBlocked(itemA)).toBe(false);
  });

  it('isBlocked returns false when blocker is done', () => {
    addDependency(itemA, itemB);
    changeWorkItemState(itemB, 'done', 'dashboard');
    expect(isBlocked(itemA)).toBe(false);
  });

  it('isBlocked returns false when blocker is cancelled', () => {
    addDependency(itemA, itemB);
    changeWorkItemState(itemB, 'cancelled', 'dashboard');
    expect(isBlocked(itemA)).toBe(false);
  });

  it('getBlockers returns unfinished blockers', () => {
    addDependency(itemA, itemB);
    addDependency(itemA, itemC);
    const blockers = getBlockers(itemA);
    expect(blockers).toHaveLength(2);
    const ids = blockers.map(b => b.id);
    expect(ids).toContain(itemB);
    expect(ids).toContain(itemC);
  });

  it('getBlockers excludes done/cancelled blockers', () => {
    addDependency(itemA, itemB);
    addDependency(itemA, itemC);
    changeWorkItemState(itemB, 'done', 'dashboard');
    const blockers = getBlockers(itemA);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].id).toBe(itemC);
  });

  it('removeDependency removes the link', () => {
    addDependency(itemA, itemB);
    expect(isBlocked(itemA)).toBe(true);
    const removed = removeDependency(itemA, itemB);
    expect(removed).toBe(true);
    expect(isBlocked(itemA)).toBe(false);
  });

  it('throws on self-dependency', () => {
    expect(() => addDependency(itemA, itemA)).toThrow(
      /cannot depend on itself/
    );
  });

  it('throws on circular dependency (A→B, B→A)', () => {
    addDependency(itemA, itemB); // A depends on B
    expect(() => addDependency(itemB, itemA)).toThrow(
      /Circular dependency/
    );
  });

  it('removeDependency returns false when dependency does not exist', () => {
    expect(removeDependency(itemA, itemB)).toBe(false);
  });
});

// ── Comments ───────────────────────────────────────────────────────────────────

describe('Comments', () => {
  let projectId: string;
  let itemId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test' });
    projectId = p.id;
    itemId = createWorkItem({ project_id: projectId, title: 'Task' }).id;
  });

  it('creates and lists comments', () => {
    createComment({ work_item_id: itemId, author: 'dashboard', body: 'This looks good' });
    createComment({ work_item_id: itemId, author: 'Coder', body: 'Working on it' });
    const comments = listComments(itemId);
    expect(comments).toHaveLength(2);
    expect(comments[0].body).toBe('This looks good');
    expect(comments[1].body).toBe('Working on it');
  });

  it('comment has correct fields', () => {
    const comment = createComment({ work_item_id: itemId, author: 'dashboard', body: 'Hello' });
    expect(comment.id).toBeTruthy();
    expect(comment.work_item_id).toBe(itemId);
    expect(comment.author).toBe('dashboard');
    expect(comment.body).toBe('Hello');
    expect(comment.created_at).toBeTruthy();
  });

  it('lists comments for specific item only', () => {
    const otherItem = createWorkItem({ project_id: projectId, title: 'Other' });
    createComment({ work_item_id: itemId, author: 'dashboard', body: 'Mine' });
    createComment({ work_item_id: otherItem.id, author: 'dashboard', body: 'Other' });
    expect(listComments(itemId)).toHaveLength(1);
    expect(listComments(otherItem.id)).toHaveLength(1);
  });

  it('blocks noise phrases like "Session restarted."', () => {
    expect(() =>
      createComment({ work_item_id: itemId, author: 'Harmony', body: 'Session restarted.' })
    ).toThrow('Comment blocked');

    // Case-insensitive
    expect(() =>
      createComment({ work_item_id: itemId, author: 'Harmony', body: 'SESSION RESTARTED.' })
    ).toThrow('Comment blocked');

    // Without trailing period
    expect(() =>
      createComment({ work_item_id: itemId, author: 'Harmony', body: 'Session restarted' })
    ).toThrow('Comment blocked');

    // With whitespace padding
    expect(() =>
      createComment({ work_item_id: itemId, author: 'Harmony', body: '  Session restarted.  ' })
    ).toThrow('Comment blocked');

    // Normal comments still work
    const comment = createComment({ work_item_id: itemId, author: 'Harmony', body: 'The session was restarted successfully.' });
    expect(comment.body).toBe('The session was restarted successfully.');
  });
});

// ── Comment Body Sanitization (TRACK-226) ──────────────────────────────────────

describe('sanitizeCommentBody', () => {
  it('returns normal text unchanged', () => {
    expect(sanitizeCommentBody('Hello world')).toBe('Hello world');
  });

  it('returns text with real newlines unchanged', () => {
    const text = 'Line 1\nLine 2\n\nLine 3';
    expect(sanitizeCommentBody(text)).toBe(text);
  });

  it('unescapes literal \\n when no real newlines present', () => {
    const input = 'Line 1\\n\\nLine 2\\nLine 3';
    expect(sanitizeCommentBody(input)).toBe('Line 1\n\nLine 2\nLine 3');
  });

  it('unescapes literal \\t when no real newlines present', () => {
    const input = 'Col1\\tCol2\\nRow2';
    expect(sanitizeCommentBody(input)).toBe('Col1\tCol2\nRow2');
  });

  it('unescapes literal \\" when no real newlines present', () => {
    const input = 'He said \\"hello\\"\\nNext line';
    expect(sanitizeCommentBody(input)).toBe('He said "hello"\nNext line');
  });

  it('unescapes literal \\\\ when no real newlines present', () => {
    const input = 'path\\\\to\\\\file\\nNext';
    expect(sanitizeCommentBody(input)).toBe('path\\to\\file\nNext');
  });

  it('leaves mixed content alone (real + literal newlines)', () => {
    // This simulates code blocks that contain literal \n alongside real newlines
    const input = 'Real newline here\n\nCode: `console.log("hello\\nworld")`';
    expect(sanitizeCommentBody(input)).toBe(input);
  });

  it('returns empty string unchanged', () => {
    expect(sanitizeCommentBody('')).toBe('');
  });
});

describe('createComment sanitizes body', () => {
  let projectId: string;
  let itemId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test' });
    projectId = p.id;
    itemId = createWorkItem({ project_id: projectId, title: 'Task' }).id;
  });

  it('sanitizes JSON-escaped newlines on insert', () => {
    const comment = createComment({
      work_item_id: itemId,
      author: 'Coder',
      body: '**Title**\\n\\nParagraph text\\nMore text',
    });
    expect(comment.body).toBe('**Title**\n\nParagraph text\nMore text');
  });

  it('leaves normal comments unchanged', () => {
    const comment = createComment({
      work_item_id: itemId,
      author: 'Coder',
      body: 'Simple comment with\nreal newlines',
    });
    expect(comment.body).toBe('Simple comment with\nreal newlines');
  });
});

// ── Approval Provenance (Description Integrity) ────────────────────────────────

describe('Approval Provenance', () => {
  let projectId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Security Test' });
    projectId = p.id;
  });

  it('records approval hash when approved', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Critical Task',
      description: 'Do the thing',
    });
    changeWorkItemState(item.id, 'approved', 'dashboard');
    const approved = getWorkItem(item.id)!;
    expect(approved.approved_description_hash).toBeTruthy();
    expect(approved.approved_description_hash!.length).toBe(64); // SHA-256 hex
  });

  it('different descriptions produce different hashes', () => {
    const itemA = createWorkItem({ project_id: projectId, title: 'A', description: 'desc A' });
    const itemB = createWorkItem({ project_id: projectId, title: 'B', description: 'desc B' });
    changeWorkItemState(itemA.id, 'approved', 'dashboard');
    changeWorkItemState(itemB.id, 'approved', 'dashboard');
    const a = getWorkItem(itemA.id)!;
    const b = getWorkItem(itemB.id)!;
    expect(a.approved_description_hash).not.toBe(b.approved_description_hash);
  });

  it('item created directly in approved state by human gets provenance', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Pre-approved',
      description: 'Some task',
      state: 'approved',
      created_by: 'dashboard',
    });
    expect(item.approved_by).toBe('dashboard');
    expect(item.approved_by_class).toBe('human');
    expect(item.approved_at).toBeTruthy();
    expect(item.approved_description_hash).toBeTruthy();
  });

  it('item created directly in approved state by agent does NOT get provenance', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Agent-approved',
      description: 'Sneaky',
      state: 'approved',
      created_by: 'Coder', // agent — this should fail to get provenance
    });
    // The item is created in 'approved' state by the db layer, but
    // isDirectApproval = false because createdByClass !== 'human'
    // So no approval provenance is recorded
    expect(item.approved_by).toBeNull();
    expect(item.approved_at).toBeNull();
    expect(item.approved_description_hash).toBeNull();
  });
});

// ── Bot Dispatch (bot_dispatch field) ──────────────────────────────────────────

describe('Bot Dispatch', () => {
  let projectId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Bot Test', short_name: 'BOT' });
    projectId = p.id;
  });

  it('defaults bot_dispatch to 0 when requires_code is false', () => {
    const item = createWorkItem({ project_id: projectId, title: 'No bot' });
    expect(item.bot_dispatch).toBe(0);
    expect(item.requires_code).toBe(0);
  });

  it('defaults bot_dispatch to 1 when requires_code is true (backward compat)', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Code item',
      requires_code: true,
    });
    expect(item.bot_dispatch).toBe(1);
    expect(item.requires_code).toBe(1);
  });

  it('allows bot_dispatch=true with requires_code=false (think-only mode)', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Think only',
      bot_dispatch: true,
      requires_code: false,
    });
    expect(item.bot_dispatch).toBe(1);
    expect(item.requires_code).toBe(0);
  });

  it('allows explicit bot_dispatch=false even when requires_code=true', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Code but no dispatch',
      bot_dispatch: false,
      requires_code: true,
    });
    expect(item.bot_dispatch).toBe(0);
    expect(item.requires_code).toBe(1);
  });

  it('updateWorkItem can set bot_dispatch independently', () => {
    const item = createWorkItem({ project_id: projectId, title: 'Update test' });
    expect(item.bot_dispatch).toBe(0);

    const updated = updateWorkItem(item.id, { bot_dispatch: 1 });
    expect(updated).toBeDefined();
    expect(updated!.bot_dispatch).toBe(1);
    expect(updated!.requires_code).toBe(0); // unchanged
  });

  it('updateWorkItem can set requires_code without affecting bot_dispatch', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'RC test',
      bot_dispatch: true,
    });
    expect(item.bot_dispatch).toBe(1);

    const updated = updateWorkItem(item.id, { requires_code: 1 });
    expect(updated).toBeDefined();
    expect(updated!.requires_code).toBe(1);
    expect(updated!.bot_dispatch).toBe(1); // unchanged
  });

  it('getDispatchableItems only returns items with bot_dispatch=1', () => {
    // Item with bot_dispatch=1, requires_code=1 (should be dispatchable)
    const codeItem = createWorkItem({
      project_id: projectId,
      title: 'Dispatchable',
      requires_code: true,
      bot_dispatch: true,
      state: 'approved',
      created_by: 'dashboard',
    });

    // Item with requires_code=1 but bot_dispatch=0 (should NOT be dispatchable)
    const noDispatch = createWorkItem({
      project_id: projectId,
      title: 'Not dispatchable',
      requires_code: true,
      bot_dispatch: false,
      state: 'approved',
      created_by: 'dashboard',
    });

    // Item with bot_dispatch=1 but requires_code=0 (think-only, SHOULD be dispatchable)
    const thinkOnly = createWorkItem({
      project_id: projectId,
      title: 'Think only dispatch',
      requires_code: false,
      bot_dispatch: true,
      state: 'approved',
      created_by: 'dashboard',
    });

    const dispatchable = getDispatchableItems(10);
    const ids = dispatchable.map(i => i.id);
    expect(ids).toContain(codeItem.id);
    expect(ids).toContain(thinkOnly.id);
    expect(ids).not.toContain(noDispatch.id);
  });

  it('getDispatchableItems excludes items without bot_dispatch even with requires_code', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Old style code item',
      requires_code: true,
      bot_dispatch: false,
      state: 'approved',
      created_by: 'dashboard',
    });

    const dispatchable = getDispatchableItems(10);
    expect(dispatchable.map(i => i.id)).not.toContain(item.id);
  });

  it('getDispatchableItems allows comment-only items without human approval', () => {
    // Comment-only item (requires_code=0) approved by agent — SHOULD be dispatchable
    // because comment-only items don't present a security risk.
    // Simulate the real flow: create in brainstorming, then agent moves to approved.
    const commentOnly = createWorkItem({
      project_id: projectId,
      title: 'Comment only agent-approved',
      description: 'Discussion item',
      requires_code: false,
      bot_dispatch: true,
      created_by: 'dashboard',
    });
    // Agent approves it (allowed for comment-only items)
    changeWorkItemState(commentOnly.id, 'approved', 'Coder');

    // Code item (requires_code=1) — agent cannot approve, so create via human
    // then verify it's dispatchable only because of human approval
    const codeItemHuman = createWorkItem({
      project_id: projectId,
      title: 'Code human-approved',
      description: 'Code change',
      requires_code: true,
      bot_dispatch: true,
      state: 'approved',
      created_by: 'dashboard',
    });

    const dispatchable = getDispatchableItems(10);
    const ids = dispatchable.map(i => i.id);
    expect(ids).toContain(commentOnly.id);
    expect(ids).toContain(codeItemHuman.id);

    // Verify agent CANNOT approve a code item (requires_code=1)
    const codeItemForAgent = createWorkItem({
      project_id: projectId,
      title: 'Code agent tries to approve',
      description: 'Code change attempt',
      requires_code: true,
      bot_dispatch: true,
      created_by: 'dashboard',
    });
    expect(() => {
      changeWorkItemState(codeItemForAgent.id, 'approved', 'Coder');
    }).toThrow(/Only human actors can approve/);
  });
});

// ── VALID_STATES and VALID_PRIORITIES ─────────────────────────────────────────

describe('Constants', () => {
  it('VALID_STATES contains all expected states', () => {
    const expected = [
      'brainstorming', 'clarification', 'approved', 'in_development',
      'in_review', 'needs_input', 'testing', 'done', 'cancelled',
    ];
    for (const state of expected) {
      expect(VALID_STATES).toContain(state);
    }
  });

  it('VALID_PRIORITIES contains all expected priorities', () => {
    const expected = ['none', 'low', 'medium', 'high', 'urgent'];
    for (const priority of expected) {
      expect(VALID_PRIORITIES).toContain(priority);
    }
  });
});

// ── Project Orchestration Flag ────────────────────────────────────────────────

describe('Project Orchestration', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it('defaults orchestration to 1 (enabled) for new projects', () => {
    const p = createProject({ name: 'Test Project' });
    expect(p.orchestration).toBe(1);
  });

  it('allows creating a project with orchestration disabled', () => {
    const p = createProject({ name: 'No Orch', orchestration: false });
    expect(p.orchestration).toBe(0);
  });

  it('allows creating a project with orchestration explicitly enabled', () => {
    const p = createProject({ name: 'With Orch', orchestration: true });
    expect(p.orchestration).toBe(1);
  });

  it('updateProject can toggle orchestration', () => {
    const p = createProject({ name: 'Toggle Test' });
    expect(p.orchestration).toBe(1);

    const updated = updateProject(p.id, { orchestration: 0 });
    expect(updated).toBeDefined();
    expect(updated!.orchestration).toBe(0);

    const re_enabled = updateProject(p.id, { orchestration: 1 });
    expect(re_enabled).toBeDefined();
    expect(re_enabled!.orchestration).toBe(1);
  });

  it('getDispatchableItems excludes items from projects with orchestration=0', () => {
    // Project with orchestration enabled
    const orchProject = createProject({ name: 'Orch Enabled', short_name: 'OE', orchestration: true });
    const orchItem = createWorkItem({
      project_id: orchProject.id,
      title: 'Dispatchable',
      requires_code: true,
      bot_dispatch: true,
      state: 'approved',
      created_by: 'dashboard',
    });

    // Project with orchestration disabled
    const noOrchProject = createProject({ name: 'Orch Disabled', short_name: 'OD', orchestration: false });
    const noOrchItem = createWorkItem({
      project_id: noOrchProject.id,
      title: 'Not Dispatchable',
      requires_code: true,
      bot_dispatch: true,
      state: 'approved',
      created_by: 'dashboard',
    });

    const dispatchable = getDispatchableItems(10);
    const ids = dispatchable.map(i => i.id);
    expect(ids).toContain(orchItem.id);
    expect(ids).not.toContain(noOrchItem.id);
  });

  it('getClarifiableItems excludes items from projects with orchestration=0', () => {
    // Project with orchestration enabled
    const orchProject = createProject({ name: 'Orch Enabled', short_name: 'CE', orchestration: true });
    const orchItem = createWorkItem({
      project_id: orchProject.id,
      title: 'Clarifiable',
      state: 'brainstorming',
      created_by: 'dashboard',
    });
    // Move to clarification manually
    changeWorkItemState(orchItem.id, 'clarification', 'dashboard');

    // Project with orchestration disabled
    const noOrchProject = createProject({ name: 'Orch Disabled', short_name: 'CD', orchestration: false });
    const noOrchItem = createWorkItem({
      project_id: noOrchProject.id,
      title: 'Not Clarifiable',
      state: 'brainstorming',
      created_by: 'dashboard',
    });
    changeWorkItemState(noOrchItem.id, 'clarification', 'dashboard');

    const clarifiable = getClarifiableItems(10);
    const ids = clarifiable.map(i => i.id);
    expect(ids).toContain(orchItem.id);
    expect(ids).not.toContain(noOrchItem.id);
  });

  // ── date_due field ──

  it('creates work items with date_due = null by default', () => {
    const project = createProject({ name: 'Due Date Test', short_name: 'DDT' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'No due date',
      created_by: 'dashboard',
    });
    expect(item.date_due).toBeNull();
  });

  it('creates work items with a specific date_due', () => {
    const project = createProject({ name: 'Due Date Test 2', short_name: 'DD2' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Has due date',
      date_due: '2026-04-15',
      created_by: 'dashboard',
    });
    expect(item.date_due).toBe('2026-04-15');

    // Verify persistence
    const fetched = getWorkItem(item.id);
    expect(fetched).toBeDefined();
    expect(fetched!.date_due).toBe('2026-04-15');
  });

  it('updates date_due on a work item', () => {
    const project = createProject({ name: 'Due Date Update', short_name: 'DDU' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Update due date',
      created_by: 'dashboard',
    });
    expect(item.date_due).toBeNull();

    // Set a due date
    const updated = updateWorkItem(item.id, { date_due: '2026-06-01' });
    expect(updated).toBeDefined();
    expect(updated!.date_due).toBe('2026-06-01');

    // Clear the due date
    const cleared = updateWorkItem(item.id, { date_due: null });
    expect(cleared).toBeDefined();
    expect(cleared!.date_due).toBeNull();
  });

  it('preserves date_due when updating other fields', () => {
    const project = createProject({ name: 'Due Date Preserve', short_name: 'DDP' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Preserve due date',
      date_due: '2026-12-25',
      created_by: 'dashboard',
    });
    expect(item.date_due).toBe('2026-12-25');

    // Update title only
    const updated = updateWorkItem(item.id, { title: 'New title' });
    expect(updated).toBeDefined();
    expect(updated!.date_due).toBe('2026-12-25');
    expect(updated!.title).toBe('New title');
  });
});

// ── Project Context ────────────────────────────────────────────────────────────

describe('Project Context', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it('creates a project with default empty context', () => {
    const p = createProject({ name: 'No Context Project' });
    expect(p.context).toBe('');
  });

  it('creates a project with explicit context', () => {
    const p = createProject({
      name: 'With Context',
      context: 'Always run tests before marking done.',
    });
    expect(p.context).toBe('Always run tests before marking done.');
  });

  it('updates project context', () => {
    const p = createProject({ name: 'Update Context' });
    expect(p.context).toBe('');

    const updated = updateProject(p.id, {
      context: 'Don\'t refactor existing code unless the item specifically asks for it.',
    });
    expect(updated).toBeDefined();
    expect(updated!.context).toBe('Don\'t refactor existing code unless the item specifically asks for it.');
  });

  it('clears project context by setting to empty string', () => {
    const p = createProject({
      name: 'Clear Context',
      context: 'Some instructions',
    });
    expect(p.context).toBe('Some instructions');

    const updated = updateProject(p.id, { context: '' });
    expect(updated).toBeDefined();
    expect(updated!.context).toBe('');
  });

  it('preserves context when updating other fields', () => {
    const p = createProject({
      name: 'Preserve Context',
      context: 'This project is in a feature freeze.',
    });

    const updated = updateProject(p.id, { name: 'New Name' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('New Name');
    expect(updated!.context).toBe('This project is in a feature freeze.');
  });

  it('context is persisted and retrievable', () => {
    const p = createProject({
      name: 'Persist Context',
      context: 'Priority items for Q1: performance and stability.',
    });

    const fetched = getProject(p.id);
    expect(fetched).toBeDefined();
    expect(fetched!.context).toBe('Priority items for Q1: performance and stability.');
  });
});

// ── Description Versioning ──────────────────────────────────────────────────────

describe('Description Versioning', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it('auto-creates a version when description changes via updateWorkItem', () => {
    const project = createProject({ name: 'Version Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Version 1 content',
    });

    // Update description — should auto-save old description as a version
    updateWorkItem(item.id, { description: 'Version 2 content' });

    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(1);
    expect(versions[0].description).toBe('Version 1 content');
    expect(versions[0].version).toBe(1);
  });

  it('does not create duplicate versions for same description', () => {
    const project = createProject({ name: 'Dup Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Original content',
    });

    // First update — creates version for "Original content"
    updateWorkItem(item.id, { description: 'Update 1' });
    // Update back to something else — creates version for "Update 1"
    updateWorkItem(item.id, { description: 'Update 2' });

    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(2);
    expect(versions[0].description).toBe('Original content');
    expect(versions[1].description).toBe('Update 1');
  });

  it('does not create a version when description is unchanged', () => {
    const project = createProject({ name: 'NoChange Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Same content',
    });

    // Update with same description — no version should be created
    updateWorkItem(item.id, { description: 'Same content' });

    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(0);
  });

  it('does not create a version when description is empty/null', () => {
    const project = createProject({ name: 'Empty Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: '',
    });

    // Update from empty — no version for empty string
    updateWorkItem(item.id, { description: 'Now has content' });

    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(0);
  });

  it('creates manual versions via createDescriptionVersion', () => {
    const project = createProject({ name: 'Manual Version' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Some lyrics',
    });

    const ver = createDescriptionVersion({
      work_item_id: item.id,
      description: 'Some lyrics',
      saved_by: 'Martin',
    });

    expect(ver.version).toBe(1);
    expect(ver.description).toBe('Some lyrics');
    expect(ver.saved_by).toBe('Martin');

    const fetched = getDescriptionVersion(ver.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(ver.id);
  });

  it('reverts to a previous version', () => {
    const project = createProject({ name: 'Revert Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Version 1',
    });

    // Create some changes to build version history
    updateWorkItem(item.id, { description: 'Version 2' });
    updateWorkItem(item.id, { description: 'Version 3' });

    // We should have 2 auto-versions: "Version 1" and "Version 2"
    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(2);
    expect(versions[0].description).toBe('Version 1');
    expect(versions[1].description).toBe('Version 2');

    // Revert to version 1
    const result = revertToDescriptionVersion(item.id, versions[0].id, 'Martin');
    expect(result).toBeDefined();
    expect(result!.item.description).toBe('Version 1');
    expect(result!.version.version).toBe(1);

    // Current description should now be "Version 1"
    const updated = getWorkItem(item.id);
    expect(updated!.description).toBe('Version 1');

    // "Version 3" should have been auto-saved as a version before revert
    const versionsAfter = listDescriptionVersions(item.id);
    expect(versionsAfter.length).toBe(3);
    expect(versionsAfter[2].description).toBe('Version 3');
  });

  it('revert returns undefined for invalid version id', () => {
    const project = createProject({ name: 'Invalid Revert' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Content',
    });

    const result = revertToDescriptionVersion(item.id, 'nonexistent-id', 'Martin');
    expect(result).toBeUndefined();
  });

  it('revert returns undefined for version belonging to different item', () => {
    const project = createProject({ name: 'Cross Item Revert' });
    const item1 = createWorkItem({
      project_id: project.id,
      title: 'Item 1',
      description: 'Content 1',
    });
    const item2 = createWorkItem({
      project_id: project.id,
      title: 'Item 2',
      description: 'Content 2',
    });

    const ver = createDescriptionVersion({
      work_item_id: item1.id,
      description: 'Content 1',
    });

    // Try to revert item2 to item1's version — should fail
    const result = revertToDescriptionVersion(item2.id, ver.id, 'Martin');
    expect(result).toBeUndefined();
  });

  it('records actor in auto-versioned snapshots', () => {
    const project = createProject({ name: 'Actor Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Original',
    });

    updateWorkItem(item.id, { description: 'Updated', actor: 'Martin' });

    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(1);
    expect(versions[0].saved_by).toBe('Martin');
  });
});

// ── moveWorkItem ──────────────────────────────────────────────────────────────

describe('moveWorkItem', () => {
  beforeEach(() => _initTestTrackerDatabase());

  it('moves an item to a different project with new seq_number', () => {
    const projectA = createProject({ name: 'Project A', short_name: 'PA' });
    const projectB = createProject({ name: 'Project B', short_name: 'PB' });
    // Create an existing item in projectB so its next_seq advances
    createWorkItem({ project_id: projectB.id, title: 'Existing in B' });
    const item = createWorkItem({ project_id: projectA.id, title: 'Movable Item' });

    expect(item.project_id).toBe(projectA.id);
    expect(item.seq_number).toBe(1); // first item in projectA

    const moved = moveWorkItem(item.id, projectB.id, 'Martin');
    expect(moved).toBeDefined();
    expect(moved!.project_id).toBe(projectB.id);
    expect(moved!.seq_number).toBe(2); // second item in projectB
    // New key should use projectB's short_name
    const key = getWorkItemKey(moved!);
    expect(key).toBe('PB-2');
  });

  it('returns existing item unchanged when moving to same project', () => {
    const project = createProject({ name: 'Same Proj' });
    const item = createWorkItem({ project_id: project.id, title: 'Static Item' });

    const result = moveWorkItem(item.id, project.id);
    expect(result).toBeDefined();
    expect(result!.project_id).toBe(project.id);
    expect(result!.seq_number).toBe(item.seq_number);
  });

  it('returns undefined for non-existent item', () => {
    const project = createProject({ name: 'Target' });
    const result = moveWorkItem('nonexistent', project.id);
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-existent target project', () => {
    const project = createProject({ name: 'Source' });
    const item = createWorkItem({ project_id: project.id, title: 'Orphan' });
    const result = moveWorkItem(item.id, 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('resets space_type to standard if not active on target project', () => {
    const projectA = createProject({ name: 'Music Proj' });
    const projectB = createProject({ name: 'Plain Proj' });
    // Set projectA to have song space active
    updateProject(projectA.id, { active_spaces: JSON.stringify(['standard', 'song']) });
    // projectB only has standard (default)
    updateProject(projectB.id, { active_spaces: JSON.stringify(['standard']) });

    const item = createWorkItem({ project_id: projectA.id, title: 'Song Item', space_type: 'song' });
    expect(item.space_type).toBe('song');

    const moved = moveWorkItem(item.id, projectB.id);
    expect(moved).toBeDefined();
    expect(moved!.space_type).toBe('standard');
    expect(moved!.space_data).toBeNull();
  });

  it('preserves space_type if active on target project', () => {
    const projectA = createProject({ name: 'Music A' });
    const projectB = createProject({ name: 'Music B' });
    updateProject(projectA.id, { active_spaces: JSON.stringify(['standard', 'song']) });
    updateProject(projectB.id, { active_spaces: JSON.stringify(['standard', 'song']) });

    const item = createWorkItem({ project_id: projectA.id, title: 'Song Item', space_type: 'song' });
    const moved = moveWorkItem(item.id, projectB.id);
    expect(moved).toBeDefined();
    expect(moved!.space_type).toBe('song');
  });

  it('resets position to 0 on move', () => {
    const projectA = createProject({ name: 'From' });
    const projectB = createProject({ name: 'To' });
    const item = createWorkItem({ project_id: projectA.id, title: 'Positioned' });
    updateWorkItem(item.id, { position: 5 });

    const moved = moveWorkItem(item.id, projectB.id);
    expect(moved).toBeDefined();
    expect(moved!.position).toBe(0);
  });

  it('records a transition when moving between projects', () => {
    const projectA = createProject({ name: 'Project Alpha', short_name: 'PA' });
    const projectB = createProject({ name: 'Project Beta', short_name: 'PB' });
    const item = createWorkItem({ project_id: projectA.id, title: 'Track Move' });

    // Move the item to a different project
    const moved = moveWorkItem(item.id, projectB.id, 'Martin');
    expect(moved).toBeDefined();

    // Check that a transition was recorded
    const transitions = listTransitions(item.id);
    // Should have: 1 initial "Created" transition + 1 move transition
    expect(transitions.length).toBe(2);

    const moveTransition = transitions[1];
    expect(moveTransition.from_state).toBe('brainstorming');
    expect(moveTransition.to_state).toBe('brainstorming');
    expect(moveTransition.actor).toBe('Martin');
    expect(moveTransition.comment).toBe('Moved from Project Alpha (PA-1) to Project Beta (PB-1)');
  });

  it('does not record a transition when moving to same project', () => {
    const project = createProject({ name: 'Same Proj', short_name: 'SP' });
    const item = createWorkItem({ project_id: project.id, title: 'Static Item' });

    moveWorkItem(item.id, project.id);

    // Only the initial "Created" transition should exist
    const transitions = listTransitions(item.id);
    expect(transitions.length).toBe(1);
  });
});

// ── Scheduled Task space_data Management ──

describe('scheduled task space_data', () => {
  beforeEach(() => _initTestTrackerDatabase());

  it('creates a scheduled task with todo and ignore lists', () => {
    const project = createProject({ name: 'Scheduled Proj' });
    const spaceData = JSON.stringify({
      schedule: { frequency: 'daily', time: '09:00', timezone: 'Australia/Perth' },
      status: { next_run: null, last_run: null, run_count: 0 },
      todo: ['Check emails', 'Review calendar'],
      ignore: ['Skip weekends'],
    });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Daily Task',
      space_type: 'scheduled',
      space_data: spaceData,
    });
    expect(item.space_type).toBe('scheduled');
    expect(item.space_data).toBe(spaceData);
    const parsed = JSON.parse(item.space_data!);
    expect(parsed.todo).toEqual(['Check emails', 'Review calendar']);
    expect(parsed.ignore).toEqual(['Skip weekends']);
  });

  it('updates todo list via space_data update', () => {
    const project = createProject({ name: 'Scheduled Proj' });
    const initialData = {
      schedule: { frequency: 'daily', time: '09:00' },
      status: { run_count: 0 },
      todo: ['Task 1'],
      ignore: [],
    };
    const item = createWorkItem({
      project_id: project.id,
      title: 'Daily Task',
      space_type: 'scheduled',
      space_data: JSON.stringify(initialData),
    });

    // Add a todo item by updating space_data
    const newData = { ...initialData, todo: ['Task 1', 'Task 2', 'Task 3'] };
    const updated = updateWorkItem(item.id, { space_data: JSON.stringify(newData) });
    expect(updated).toBeDefined();
    const parsed = JSON.parse(updated!.space_data!);
    expect(parsed.todo).toEqual(['Task 1', 'Task 2', 'Task 3']);
  });

  it('removes todo items by index correctly', () => {
    const project = createProject({ name: 'Scheduled Proj' });
    const data = {
      schedule: { frequency: 'daily' },
      status: {},
      todo: ['A', 'B', 'C', 'D', 'E'],
      ignore: ['rule1'],
    };
    const item = createWorkItem({
      project_id: project.id,
      title: 'Task',
      space_type: 'scheduled',
      space_data: JSON.stringify(data),
    });

    // Remove indices 1 and 3 (B and D)
    const todo = [...data.todo];
    const sortedIndices = [3, 1]; // reverse order
    for (const idx of sortedIndices) {
      todo.splice(idx, 1);
    }
    expect(todo).toEqual(['A', 'C', 'E']);

    const newData = { ...data, todo };
    const updated = updateWorkItem(item.id, { space_data: JSON.stringify(newData) });
    const parsed = JSON.parse(updated!.space_data!);
    expect(parsed.todo).toEqual(['A', 'C', 'E']);
    // Ignore list should be unchanged
    expect(parsed.ignore).toEqual(['rule1']);
  });

  it('handles empty space_data gracefully', () => {
    const project = createProject({ name: 'Scheduled Proj' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Empty Task',
      space_type: 'scheduled',
    });
    expect(item.space_type).toBe('scheduled');
    expect(item.space_data).toBeNull();

    // Setting space_data with just todo should work
    const newData = {
      schedule: { frequency: 'daily', time: '09:00' },
      status: {},
      todo: ['First task'],
      ignore: [],
    };
    const updated = updateWorkItem(item.id, { space_data: JSON.stringify(newData) });
    expect(updated).toBeDefined();
    const parsed = JSON.parse(updated!.space_data!);
    expect(parsed.todo).toEqual(['First task']);
  });

  it('preserves schedule and status when modifying todo/ignore', () => {
    const project = createProject({ name: 'Scheduled Proj' });
    const data = {
      schedule: { frequency: 'weekly', time: '08:30', days_of_week: ['monday', 'friday'], timezone: 'Australia/Perth' },
      status: { next_run: '2026-03-14T00:30:00Z', last_run: '2026-03-13T00:30:00Z', run_count: 5 },
      todo: ['Original task'],
      ignore: ['Original rule'],
    };
    const item = createWorkItem({
      project_id: project.id,
      title: 'Weekly Task',
      space_type: 'scheduled',
      space_data: JSON.stringify(data),
    });

    // Modify only the todo list
    const newData = { ...data, todo: ['Updated task 1', 'Updated task 2'] };
    const updated = updateWorkItem(item.id, { space_data: JSON.stringify(newData) });
    const parsed = JSON.parse(updated!.space_data!);

    // Schedule and status should be preserved
    expect(parsed.schedule.frequency).toBe('weekly');
    expect(parsed.schedule.days_of_week).toEqual(['monday', 'friday']);
    expect(parsed.status.run_count).toBe(5);
    expect(parsed.status.next_run).toBe('2026-03-14T00:30:00Z');

    // Todo should be updated
    expect(parsed.todo).toEqual(['Updated task 1', 'Updated task 2']);
    // Ignore should be unchanged
    expect(parsed.ignore).toEqual(['Original rule']);
  });
});

// ── Activity Log ───────────────────────────────────────────────────────────────

describe('Activity Log', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  describe('logActivity and listActivity', () => {
    it('inserts and retrieves an activity entry', () => {
      logActivity({
        project_id: 'proj1',
        item_id: 'item1',
        action: 'item.created',
        actor: 'dashboard',
        summary: 'Created TRACK-1: Test item',
        details: { title: 'Test item', state: 'brainstorming', priority: 'none' },
      });

      const entries = listActivity();
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('item.created');
      expect(entries[0].actor).toBe('dashboard');
      expect(entries[0].actor_class).toBe('human');
      expect(entries[0].summary).toBe('Created TRACK-1: Test item');
      expect(entries[0].project_id).toBe('proj1');
      expect(entries[0].item_id).toBe('item1');
      const details = JSON.parse(entries[0].details!);
      expect(details.title).toBe('Test item');
    });

    it('classifies actors correctly', () => {
      logActivity({ action: 'test', actor: 'dashboard', summary: 'human' });
      logActivity({ action: 'test', actor: 'Coder', summary: 'agent' });
      logActivity({ action: 'test', actor: 'orchestrator', summary: 'system' });
      logActivity({ action: 'test', actor: 'unknown', summary: 'api' });

      const entries = listActivity({ limit: 10 });
      // Most recent first
      expect(entries.find(e => e.summary === 'human')!.actor_class).toBe('human');
      expect(entries.find(e => e.summary === 'agent')!.actor_class).toBe('agent');
      expect(entries.find(e => e.summary === 'system')!.actor_class).toBe('system');
      expect(entries.find(e => e.summary === 'api')!.actor_class).toBe('api');
    });

    it('filters by project_id', () => {
      logActivity({ project_id: 'p1', action: 'test', actor: 'system', summary: 'a' });
      logActivity({ project_id: 'p2', action: 'test', actor: 'system', summary: 'b' });

      const filtered = listActivity({ project_id: 'p1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].summary).toBe('a');
    });

    it('filters by item_id', () => {
      logActivity({ item_id: 'i1', action: 'test', actor: 'system', summary: 'a' });
      logActivity({ item_id: 'i2', action: 'test', actor: 'system', summary: 'b' });

      const filtered = listActivity({ item_id: 'i1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].summary).toBe('a');
    });

    it('filters by action', () => {
      logActivity({ action: 'item.created', actor: 'system', summary: 'a' });
      logActivity({ action: 'item.updated', actor: 'system', summary: 'b' });

      const filtered = listActivity({ action: 'item.created' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].summary).toBe('a');
    });

    it('filters by actor', () => {
      logActivity({ action: 'test', actor: 'Coder', summary: 'a' });
      logActivity({ action: 'test', actor: 'dashboard', summary: 'b' });

      const filtered = listActivity({ actor: 'Coder' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].summary).toBe('a');
    });

    it('supports search in summary', () => {
      logActivity({ action: 'test', actor: 'system', summary: 'Changed priority from low to high' });
      logActivity({ action: 'test', actor: 'system', summary: 'Created TRACK-1: New feature' });

      const filtered = listActivity({ search: 'priority' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].summary).toContain('priority');
    });

    it('respects limit and offset', () => {
      for (let i = 0; i < 10; i++) {
        logActivity({ action: 'test', actor: 'system', summary: `entry-${i}` });
      }

      const page1 = listActivity({ limit: 3, offset: 0 });
      expect(page1).toHaveLength(3);

      const page2 = listActivity({ limit: 3, offset: 3 });
      expect(page2).toHaveLength(3);

      // Entries are ordered by created_at DESC, so page1 has newest
      expect(page1[0].summary).not.toBe(page2[0].summary);
    });

    it('clamps limit to max 200', () => {
      for (let i = 0; i < 5; i++) {
        logActivity({ action: 'test', actor: 'system', summary: `entry-${i}` });
      }
      // Requesting 999 should be clamped to 200, but we only have 5 entries
      const entries = listActivity({ limit: 999 });
      expect(entries).toHaveLength(5);
    });

    it('handles nullable project_id and item_id', () => {
      logActivity({ action: 'test', actor: 'system', summary: 'global event' });

      const entries = listActivity();
      expect(entries[0].project_id).toBeNull();
      expect(entries[0].item_id).toBeNull();
    });
  });

  describe('Integration: mutations produce activity log entries', () => {
    it('createWorkItem logs item.created', () => {
      const project = createProject({ name: 'Test' });
      createWorkItem({ project_id: project.id, title: 'My Item', created_by: 'dashboard' });

      const entries = listActivity({ action: 'item.created' });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].summary).toContain('My Item');
      expect(entries[0].actor).toBe('dashboard');
    });

    it('updateWorkItem logs field changes', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item', priority: 'none' as any });

      updateWorkItem(item.id, { priority: 'high' as any, actor: 'dashboard' });

      const entries = listActivity({ action: 'item.updated' });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const priorityEntry = entries.find(e => e.summary.includes('priority'));
      expect(priorityEntry).toBeDefined();
      expect(priorityEntry!.summary).toContain('none');
      expect(priorityEntry!.summary).toContain('high');
    });

    it('updateWorkItem does not log unchanged fields', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item', priority: 'high' as any });

      // Update with the same priority — should not log
      updateWorkItem(item.id, { priority: 'high' as any, actor: 'dashboard' });

      const entries = listActivity({ action: 'item.updated' });
      expect(entries).toHaveLength(0);
    });

    it('changeWorkItemState logs item.state_changed', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item', created_by: 'dashboard' });

      changeWorkItemState(item.id, 'approved', 'dashboard');

      const entries = listActivity({ action: 'item.state_changed' });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].summary).toContain('brainstorming');
      expect(entries[0].summary).toContain('approved');
    });

    it('moveWorkItem logs item.moved', () => {
      const proj1 = createProject({ name: 'Source' });
      const proj2 = createProject({ name: 'Target' });
      const item = createWorkItem({ project_id: proj1.id, title: 'Movable' });

      moveWorkItem(item.id, proj2.id, 'dashboard');

      const entries = listActivity({ action: 'item.moved' });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].summary).toContain('Source');
      expect(entries[0].summary).toContain('Target');
    });

    it('lockWorkItem and unlockWorkItem log events', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item' });

      lockWorkItem(item.id, 'Coder');
      unlockWorkItem(item.id);

      const lockEntries = listActivity({ action: 'item.locked' });
      expect(lockEntries).toHaveLength(1);
      expect(lockEntries[0].summary).toContain('Coder');

      const unlockEntries = listActivity({ action: 'item.unlocked' });
      expect(unlockEntries).toHaveLength(1);
      expect(unlockEntries[0].summary).toBe('Unlocked');
    });

    it('createAttachment logs attachment.uploaded', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item' });

      createAttachment({
        work_item_id: item.id,
        filename: 'test.png',
        mime_type: 'image/png',
        size_bytes: 1024,
        storage_path: 'attachments/test.png',
        uploaded_by: 'Coder',
      });

      const entries = listActivity({ action: 'attachment.uploaded' });
      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toContain('test.png');
      expect(entries[0].summary).toContain('1KB');
    });

    it('deleteAttachment logs attachment.deleted', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item' });

      const att = createAttachment({
        work_item_id: item.id,
        filename: 'test.png',
        mime_type: 'image/png',
        size_bytes: 1024,
        storage_path: 'attachments/test.png',
        uploaded_by: 'Coder',
      });

      deleteAttachment(att.id);

      const entries = listActivity({ action: 'attachment.deleted' });
      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toContain('test.png');
    });

    it('deleteComment logs comment.deleted', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item' });

      const comment = createComment({
        work_item_id: item.id,
        author: 'Martin',
        body: 'Test comment to delete',
      });

      const deleted = deleteComment(comment.id);
      expect(deleted).toBeDefined();
      expect(deleted!.id).toBe(comment.id);

      const entries = listActivity({ action: 'comment.deleted' });
      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toContain('Martin');
      expect(entries[0].item_id).toBe(item.id);
    });

    it('deleteComment uses provided actor', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item' });
      const comment = createComment({
        work_item_id: item.id,
        author: 'Martin',
        body: 'Test comment',
      });

      deleteComment(comment.id, 'dashboard');
      const entries = listActivity({ action: 'comment.deleted' });
      expect(entries).toHaveLength(1);
      expect(entries[0].actor).toBe('dashboard');
      expect(entries[0].actor_class).toBe('human');
    });

    it('updateComment logs comment.edited', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item' });
      const comment = createComment({
        work_item_id: item.id,
        author: 'Martin',
        body: 'Original text',
      });

      updateComment(comment.id, { body: 'Updated text', actor: 'dashboard' });
      const entries = listActivity({ action: 'comment.edited' });
      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toContain('Martin');
      expect(entries[0].actor).toBe('dashboard');
      expect(entries[0].item_id).toBe(item.id);
    });

    it('createComment logs comment.created', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item' });
      const comment = createComment({
        work_item_id: item.id,
        author: 'Martin',
        body: 'Hello world',
      });

      const entries = listActivity({ action: 'comment.created' });
      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toBe('Added comment by Martin');
      expect(entries[0].actor).toBe('Martin');
      expect(entries[0].item_id).toBe(item.id);
      expect(entries[0].project_id).toBe(project.id);
      const details = JSON.parse(entries[0].details!);
      expect(details.comment_id).toBe(comment.id);
      expect(details.author).toBe('Martin');
    });

    it('updateWorkItem logs description.edited', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item' });

      updateWorkItem(item.id, { description: 'New description text', actor: 'dashboard' });

      const entries = listActivity({ action: 'description.edited' });
      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toBe('Edited description');
      expect(entries[0].actor).toBe('dashboard');
      expect(entries[0].item_id).toBe(item.id);
      expect(entries[0].project_id).toBe(project.id);
    });

    it('updateWorkItem does not log description.edited when description unchanged', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item' });

      // Set an initial description
      updateWorkItem(item.id, { description: 'Initial', actor: 'dashboard' });

      // Clear previous entries by checking count
      const before = listActivity({ action: 'description.edited' });

      // Update with the same description
      updateWorkItem(item.id, { description: 'Initial', actor: 'dashboard' });

      const after = listActivity({ action: 'description.edited' });
      expect(after).toHaveLength(before.length); // No new entry
    });

    it('deleteAttachment uses provided actor', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Item' });
      const attachment = createAttachment({
        work_item_id: item.id,
        filename: 'test.png',
        mime_type: 'image/png',
        size_bytes: 1000,
        storage_path: 'attachments/test.png',
      });

      deleteAttachment(attachment.id, 'dashboard');
      const entries = listActivity({ action: 'attachment.deleted' });
      expect(entries).toHaveLength(1);
      expect(entries[0].actor).toBe('dashboard');
      expect(entries[0].actor_class).toBe('human');
    });

    it('deleteWorkItem cleans up activity log entries', () => {
      const project = createProject({ name: 'Test' });
      const item = createWorkItem({ project_id: project.id, title: 'Temp Item', created_by: 'dashboard' });

      // Should have at least the created entry
      const beforeDelete = listActivity({ item_id: item.id });
      expect(beforeDelete.length).toBeGreaterThan(0);

      // Delete the item — should clean up activity entries
      const deleted = deleteWorkItem(item.id);
      expect(deleted).toBe(true);

      const afterDelete = listActivity({ item_id: item.id });
      expect(afterDelete).toHaveLength(0);
    });
  });
});

// ── Comment Reactions ──────────────────────────────────────────────────────────

describe('Comment Reactions', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  function setup() {
    const project = createProject({ name: 'Test' });
    const item = createWorkItem({ project_id: project.id, title: 'Test item', created_by: 'dashboard' });
    const comment = createComment({ work_item_id: item.id, author: 'me', body: 'Hello' });
    return { project, item, comment };
  }

  it('adds a reaction (toggle on)', () => {
    const { comment } = setup();
    const result = toggleReaction(comment.id, '\ud83d\udc4d', 'me');
    expect(result.added).toBe(true);
    expect(result.reactions).toHaveLength(1);
    expect(result.reactions[0]).toEqual({ emoji: '\ud83d\udc4d', count: 1, authors: ['me'] });
  });

  it('removes a reaction (toggle off)', () => {
    const { comment } = setup();
    toggleReaction(comment.id, '\ud83d\udc4d', 'me');
    const result = toggleReaction(comment.id, '\ud83d\udc4d', 'me');
    expect(result.added).toBe(false);
    expect(result.reactions).toHaveLength(0);
  });

  it('enforces uniqueness — same author + emoji is a toggle', () => {
    const { comment } = setup();
    toggleReaction(comment.id, '\ud83d\udc4d', 'me');
    toggleReaction(comment.id, '\ud83d\udc4d', 'me'); // toggle off
    const result = toggleReaction(comment.id, '\ud83d\udc4d', 'me'); // toggle on again
    expect(result.added).toBe(true);
    expect(result.reactions[0].count).toBe(1);
  });

  it('allows multiple emojis from same author', () => {
    const { comment } = setup();
    toggleReaction(comment.id, '\ud83d\udc4d', 'me');
    toggleReaction(comment.id, '\u2764\ufe0f', 'me');
    const reactions = getReactions(comment.id);
    expect(reactions).toHaveLength(2);
    expect(reactions.map(r => r.emoji)).toContain('\ud83d\udc4d');
    expect(reactions.map(r => r.emoji)).toContain('\u2764\ufe0f');
  });

  it('aggregates counts from multiple authors', () => {
    const { comment } = setup();
    toggleReaction(comment.id, '\ud83d\udc4d', 'me');
    toggleReaction(comment.id, '\ud83d\udc4d', 'Coder');
    toggleReaction(comment.id, '\ud83d\udc4d', 'dashboard');
    const reactions = getReactions(comment.id);
    expect(reactions).toHaveLength(1);
    expect(reactions[0].count).toBe(3);
    expect(reactions[0].authors).toEqual(expect.arrayContaining(['me', 'Coder', 'dashboard']));
  });

  it('batch loads reactions for multiple comments', () => {
    const { item } = setup();
    const c1 = createComment({ work_item_id: item.id, author: 'me', body: 'First' });
    const c2 = createComment({ work_item_id: item.id, author: 'me', body: 'Second' });
    toggleReaction(c1.id, '\ud83d\udc4d', 'me');
    toggleReaction(c2.id, '\u2764\ufe0f', 'Coder');
    const batch = getReactionsBatch([c1.id, c2.id]);
    expect(batch[c1.id]).toHaveLength(1);
    expect(batch[c1.id][0].emoji).toBe('\ud83d\udc4d');
    expect(batch[c2.id]).toHaveLength(1);
    expect(batch[c2.id][0].emoji).toBe('\u2764\ufe0f');
  });

  it('returns empty map for empty input', () => {
    const batch = getReactionsBatch([]);
    expect(batch).toEqual({});
  });

  it('cascade deletes reactions when comment is deleted', () => {
    const { comment } = setup();
    toggleReaction(comment.id, '\ud83d\udc4d', 'me');
    toggleReaction(comment.id, '\u2764\ufe0f', 'Coder');
    expect(getReactions(comment.id)).toHaveLength(2);
    deleteComment(comment.id);
    expect(getReactions(comment.id)).toHaveLength(0);
  });

  it('logs activity on toggle', () => {
    const { comment, item } = setup();
    toggleReaction(comment.id, '\ud83d\udc4d', 'me');
    const added = listActivity({ item_id: item.id, action: 'reaction.added' });
    expect(added.length).toBeGreaterThan(0);
    expect(added[0].summary).toContain('\ud83d\udc4d');

    toggleReaction(comment.id, '\ud83d\udc4d', 'me');
    const removed = listActivity({ item_id: item.id, action: 'reaction.removed' });
    expect(removed.length).toBeGreaterThan(0);
  });

  it('throws when comment does not exist', () => {
    _initTestTrackerDatabase();
    expect(() => toggleReaction('nonexistent', '\ud83d\udc4d', 'me')).toThrow('Comment not found');
  });
});

// ── Tracker-wide Settings (TRACK-271) ──

describe('tracker-wide settings', () => {
  beforeEach(() => _initTestTrackerDatabase());

  it('returns default when key does not exist', () => {
    expect(getSetting('nonexistent')).toBeUndefined();
    expect(getSetting('nonexistent', 'fallback')).toBe('fallback');
  });

  it('stores and retrieves a string setting', () => {
    setSetting('coder_model_id', 'claude-sonnet-4-6');
    expect(getSetting('coder_model_id')).toBe('claude-sonnet-4-6');
  });

  it('stores and retrieves a numeric setting', () => {
    setSetting('max_concurrent', 5);
    expect(getSetting('max_concurrent')).toBe(5);
  });

  it('overwrites existing setting (upsert)', () => {
    setSetting('coder_model_id', 'claude-opus-4-6');
    expect(getSetting('coder_model_id')).toBe('claude-opus-4-6');

    setSetting('coder_model_id', 'claude-sonnet-4-6');
    expect(getSetting('coder_model_id')).toBe('claude-sonnet-4-6');
  });

  it('getAllSettings returns all stored settings', () => {
    setSetting('coder_model_id', 'claude-opus-4-6');
    setSetting('model_strength_high', 'claude-opus-4-6');
    setSetting('model_strength_low', 'claude-haiku-4-5-20251001');

    const all = getAllSettings();
    expect(all.coder_model_id).toBe('claude-opus-4-6');
    expect(all.model_strength_high).toBe('claude-opus-4-6');
    expect(all.model_strength_low).toBe('claude-haiku-4-5-20251001');
  });

  it('getAllSettings returns empty object when no settings exist', () => {
    const all = getAllSettings();
    expect(Object.keys(all).length).toBe(0);
  });
});

// ── Links (TRACK-280) ─────────────────────────────────────────────────────────

describe('Links', () => {
  let projectId: string;
  let itemA: string;
  let itemB: string;
  let itemC: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test', short_name: 'TST' });
    projectId = p.id;
    itemA = createWorkItem({ project_id: projectId, title: 'A' }).id;
    itemB = createWorkItem({ project_id: projectId, title: 'B' }).id;
    itemC = createWorkItem({ project_id: projectId, title: 'C' }).id;
  });

  describe('addLink', () => {
    it('adds a directional link', () => {
      const link = addLink({
        from_item_id: itemA,
        to_item_id: itemB,
        relation: 'duplicates',
        created_by: 'dashboard',
      });
      expect(link.from_item_id).toBe(itemA);
      expect(link.to_item_id).toBe(itemB);
      expect(link.relation).toBe('duplicates');
      expect(link.symmetric).toBe(0);
      expect(link.source).toBe('manual');
    });

    it('marks symmetric relations with symmetric=1', () => {
      const link = addLink({
        from_item_id: itemA,
        to_item_id: itemB,
        relation: 'relates_to',
        created_by: 'dashboard',
      });
      expect(link.symmetric).toBe(1);
    });

    it('is idempotent on (from, to, relation)', () => {
      const a = addLink({
        from_item_id: itemA,
        to_item_id: itemB,
        relation: 'duplicates',
        created_by: 'dashboard',
      });
      const b = addLink({
        from_item_id: itemA,
        to_item_id: itemB,
        relation: 'duplicates',
        created_by: 'dashboard',
      });
      expect(a.id).toBe(b.id);
    });

    it('symmetric relation: re-adding inverse direction returns existing row', () => {
      const a = addLink({
        from_item_id: itemA,
        to_item_id: itemB,
        relation: 'relates_to',
        created_by: 'dashboard',
      });
      const b = addLink({
        from_item_id: itemB,
        to_item_id: itemA,
        relation: 'relates_to',
        created_by: 'dashboard',
      });
      expect(a.id).toBe(b.id);
    });

    it('updates note on idempotent re-add', () => {
      addLink({
        from_item_id: itemA,
        to_item_id: itemB,
        relation: 'duplicates',
        created_by: 'dashboard',
        note: 'first',
      });
      const updated = addLink({
        from_item_id: itemA,
        to_item_id: itemB,
        relation: 'duplicates',
        created_by: 'dashboard',
        note: 'second',
      });
      expect(updated.note).toBe('second');
    });

    it('rejects self-links', () => {
      expect(() =>
        addLink({
          from_item_id: itemA,
          to_item_id: itemA,
          relation: 'relates_to',
          created_by: 'dashboard',
        }),
      ).toThrow(/cannot link to itself/);
    });

    it('rejects unknown relations', () => {
      expect(() =>
        addLink({
          from_item_id: itemA,
          to_item_id: itemB,
          relation: 'bogus',
          created_by: 'dashboard',
        }),
      ).toThrow(/Invalid relation/);
    });

    it('rejects missing target item', () => {
      expect(() =>
        addLink({
          from_item_id: itemA,
          to_item_id: 'nonexistent',
          relation: 'relates_to',
          created_by: 'dashboard',
        }),
      ).toThrow(/not found/);
    });

    it('writes an activity log entry', () => {
      addLink({
        from_item_id: itemA,
        to_item_id: itemB,
        relation: 'duplicates',
        created_by: 'dashboard',
      });
      const entries = listActivity({ item_id: itemA, action: 'link.added' });
      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toMatch(/duplicates/);
    });
  });

  describe('removeLink', () => {
    it('removes a directional link', () => {
      addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'duplicates', created_by: 'dashboard' });
      const ok = removeLink({ from_item_id: itemA, to_item_id: itemB, relation: 'duplicates' });
      expect(ok).toBe(true);
      expect(listLinks(itemA)).toHaveLength(0);
    });

    it('returns false when link does not exist', () => {
      const ok = removeLink({ from_item_id: itemA, to_item_id: itemB, relation: 'duplicates' });
      expect(ok).toBe(false);
    });

    it('symmetric: removes the link regardless of perspective', () => {
      addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'relates_to', created_by: 'dashboard' });
      // Remove from the inverse direction — should still work.
      const ok = removeLink({ from_item_id: itemB, to_item_id: itemA, relation: 'relates_to' });
      expect(ok).toBe(true);
      expect(listLinks(itemA)).toHaveLength(0);
    });

    it('writes an activity log entry on remove', () => {
      addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'duplicates', created_by: 'dashboard' });
      removeLink({ from_item_id: itemA, to_item_id: itemB, relation: 'duplicates', actor: 'dashboard' });
      const entries = listActivity({ item_id: itemA, action: 'link.removed' });
      expect(entries).toHaveLength(1);
    });
  });

  describe('removeLinkById', () => {
    it('removes a link by its row id', () => {
      const link = addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'duplicates', created_by: 'dashboard' });
      const ok = removeLinkById(link.id);
      expect(ok).toBe(true);
      expect(listLinks(itemA)).toHaveLength(0);
    });

    it('returns false for an unknown link id', () => {
      expect(removeLinkById('nonexistent')).toBe(false);
    });
  });

  describe('listLinks', () => {
    it('returns empty array for items with no links', () => {
      expect(listLinks(itemA)).toEqual([]);
    });

    it('returns directional links from the source perspective', () => {
      addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'duplicates', created_by: 'dashboard' });
      const fromA = listLinks(itemA);
      expect(fromA).toHaveLength(1);
      expect(fromA[0].perspective_relation).toBe('duplicates');
      expect(fromA[0].other_item_id).toBe(itemB);
      expect(fromA[0].is_inverse).toBe(false);
    });

    it('returns the inverse relation when listing from the target perspective', () => {
      addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'duplicates', created_by: 'dashboard' });
      const fromB = listLinks(itemB);
      expect(fromB).toHaveLength(1);
      expect(fromB[0].perspective_relation).toBe('duplicated_by');
      expect(fromB[0].other_item_id).toBe(itemA);
      expect(fromB[0].is_inverse).toBe(true);
    });

    it('symmetric relation visible from both perspectives without is_inverse', () => {
      addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'relates_to', created_by: 'dashboard' });
      const fromA = listLinks(itemA);
      const fromB = listLinks(itemB);
      expect(fromA).toHaveLength(1);
      expect(fromB).toHaveLength(1);
      expect(fromA[0].perspective_relation).toBe('relates_to');
      expect(fromB[0].perspective_relation).toBe('relates_to');
      expect(fromA[0].is_inverse).toBe(false);
      expect(fromB[0].is_inverse).toBe(false);
    });

    it('filters by relation', () => {
      addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'duplicates', created_by: 'dashboard' });
      addLink({ from_item_id: itemA, to_item_id: itemC, relation: 'relates_to', created_by: 'dashboard' });
      const dupes = listLinks(itemA, 'duplicates');
      expect(dupes).toHaveLength(1);
      expect(dupes[0].other_item_id).toBe(itemB);
    });

    it('parent_of/child_of inverse expansion', () => {
      addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'parent_of', created_by: 'dashboard' });
      const fromB = listLinks(itemB);
      expect(fromB[0].perspective_relation).toBe('child_of');
    });

    it('handles many links of mixed relations', () => {
      addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'duplicates', created_by: 'dashboard' });
      addLink({ from_item_id: itemA, to_item_id: itemC, relation: 'relates_to', created_by: 'dashboard' });
      addLink({ from_item_id: itemB, to_item_id: itemA, relation: 'parent_of', created_by: 'dashboard' });
      const fromA = listLinks(itemA);
      // 3 visible: A→B (duplicates), A↔C (relates_to), B→A (child_of inverse)
      expect(fromA).toHaveLength(3);
    });
  });

  describe('getLinksAmongItems (TRACK-289)', () => {
    it('returns empty for fewer than 2 ids', () => {
      expect(getLinksAmongItems([])).toEqual([]);
      expect(getLinksAmongItems([itemA])).toEqual([]);
    });

    it('returns only edges where both endpoints are in the set', () => {
      const itemD = createWorkItem({ project_id: projectId, title: 'D' }).id;
      addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'relates_to', created_by: 'dashboard' });
      addLink({ from_item_id: itemA, to_item_id: itemD, relation: 'duplicates', created_by: 'dashboard' });
      const edges = getLinksAmongItems([itemA, itemB, itemC]);
      expect(edges).toHaveLength(1);
      expect(edges[0].from_item_id).toBe(itemA);
      expect(edges[0].to_item_id).toBe(itemB);
      expect(edges[0].relation).toBe('relates_to');
    });

    it('returns edges across all relations (not just relates_to)', () => {
      addLink({ from_item_id: itemA, to_item_id: itemB, relation: 'parent_of', created_by: 'dashboard' });
      addLink({ from_item_id: itemB, to_item_id: itemC, relation: 'duplicates', created_by: 'dashboard' });
      const edges = getLinksAmongItems([itemA, itemB, itemC]);
      expect(edges).toHaveLength(2);
      const rels = edges.map((e) => e.relation).sort();
      expect(rels).toEqual(['duplicates', 'parent_of']);
    });
  });

  describe('extractMentionKeys', () => {
    it('finds standard tracker keys', () => {
      expect(extractMentionKeys('See TRACK-5 and LIZ-10.')).toEqual(
        expect.arrayContaining(['TRACK-5', 'LIZ-10']),
      );
    });

    it('dedupes repeated keys', () => {
      const keys = extractMentionKeys('TRACK-5 TRACK-5 TRACK-5');
      expect(keys).toEqual(['TRACK-5']);
    });

    it('ignores single-letter prefixes (false positives)', () => {
      expect(extractMentionKeys('A-1 needs review')).toEqual([]);
    });

    it('returns empty array for empty input', () => {
      expect(extractMentionKeys('')).toEqual([]);
      expect(extractMentionKeys('no keys here')).toEqual([]);
    });

    it('handles multi-line text', () => {
      expect(extractMentionKeys('TRACK-1\nTRACK-2\n\nTRACK-3')).toEqual(
        expect.arrayContaining(['TRACK-1', 'TRACK-2', 'TRACK-3']),
      );
    });
  });

  describe('mention auto-extraction on item create', () => {
    it('creates mention links to existing items referenced in description', () => {
      const target = createWorkItem({ project_id: projectId, title: 'Target' });
      const targetKey = `TST-${target.seq_number}`;
      const mentioner = createWorkItem({
        project_id: projectId,
        title: 'Mentioner',
        description: `Refs ${targetKey} for context.`,
      });
      const links = listLinks(mentioner.id, 'mentions');
      expect(links).toHaveLength(1);
      expect(links[0].other_item_id).toBe(target.id);
      expect(links[0].source).toBe('mention');
    });

    it('skips self-mentions silently', () => {
      // Item references its own key in description — should not produce a self-link.
      // The seq is allocated atomically; we need to peek at the project's next_seq.
      // Simpler approach: just verify no self-links exist after create.
      const item = createWorkItem({
        project_id: projectId,
        title: 'TST-99 in title',
        description: 'TST-99 reference',
      });
      const links = listLinks(item.id);
      expect(links.every((l) => l.other_item_id !== item.id)).toBe(true);
    });

    it('skips unresolved keys (item does not exist)', () => {
      const item = createWorkItem({
        project_id: projectId,
        title: 'Test',
        description: 'See NOSUCH-99 for details.',
      });
      const links = listLinks(item.id, 'mentions');
      expect(links).toHaveLength(0);
    });
  });

  describe('mention auto-extraction on item update', () => {
    it('adds links when description is updated to reference new items', () => {
      const target = createWorkItem({ project_id: projectId, title: 'Target' });
      const targetKey = `TST-${target.seq_number}`;
      const mentioner = createWorkItem({
        project_id: projectId,
        title: 'No refs yet',
        description: '',
      });
      expect(listLinks(mentioner.id, 'mentions')).toHaveLength(0);

      updateWorkItem(mentioner.id, {
        description: `Now references ${targetKey}.`,
        actor: 'dashboard',
      });
      expect(listLinks(mentioner.id, 'mentions')).toHaveLength(1);
    });

    it('removes stale mention links when description no longer references them', () => {
      const target = createWorkItem({ project_id: projectId, title: 'Target' });
      const targetKey = `TST-${target.seq_number}`;
      const mentioner = createWorkItem({
        project_id: projectId,
        title: 'Mentioner',
        description: `Initial ${targetKey} ref.`,
      });
      expect(listLinks(mentioner.id, 'mentions')).toHaveLength(1);

      updateWorkItem(mentioner.id, {
        description: 'No more refs.',
        actor: 'dashboard',
      });
      expect(listLinks(mentioner.id, 'mentions')).toHaveLength(0);
    });

    it('does not remove manual links during mention reconciliation', () => {
      const target = createWorkItem({ project_id: projectId, title: 'Target' });
      const mentioner = createWorkItem({
        project_id: projectId,
        title: 'Mentioner',
      });

      addLink({
        from_item_id: mentioner.id,
        to_item_id: target.id,
        relation: 'relates_to',
        created_by: 'dashboard',
        source: 'manual',
      });

      updateWorkItem(mentioner.id, {
        description: 'No refs here.',
        actor: 'dashboard',
      });

      const links = listLinks(mentioner.id, 'relates_to');
      expect(links).toHaveLength(1);
    });

    it('reconcileMentionLinks is idempotent', () => {
      const target = createWorkItem({ project_id: projectId, title: 'Target' });
      const targetKey = `TST-${target.seq_number}`;
      const mentioner = createWorkItem({
        project_id: projectId,
        title: 'Mentioner',
        description: `Refs ${targetKey}.`,
      });
      reconcileMentionLinks(mentioner.id, 'dashboard');
      reconcileMentionLinks(mentioner.id, 'dashboard');
      expect(listLinks(mentioner.id, 'mentions')).toHaveLength(1);
    });
  });

  describe('VALID_LINK_RELATIONS', () => {
    it('exports the expected enum', () => {
      expect(VALID_LINK_RELATIONS).toContain('relates_to');
      expect(VALID_LINK_RELATIONS).toContain('duplicates');
      expect(VALID_LINK_RELATIONS).toContain('parent_of');
      expect(VALID_LINK_RELATIONS).toContain('mentions');
    });
  });
});

// ── Groups (TRACK-281) ────────────────────────────────────────────────────────

describe('Groups (parent_of)', () => {
  let projectId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Group Test', short_name: 'GT' });
    projectId = p.id;
  });

  describe('wouldCreateParentCycle', () => {
    it('detects self-parent as a cycle', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      expect(wouldCreateParentCycle(a.id, a.id)).toBe(true);
    });

    it('returns false when no parent_of edges exist', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      const b = createWorkItem({ project_id: projectId, title: 'B' });
      expect(wouldCreateParentCycle(a.id, b.id)).toBe(false);
    });

    it('detects a direct cycle (a→b then b→a)', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      const b = createWorkItem({ project_id: projectId, title: 'B' });
      addLink({
        from_item_id: a.id,
        to_item_id: b.id,
        relation: 'parent_of',
        created_by: 'dashboard',
      });
      expect(wouldCreateParentCycle(b.id, a.id)).toBe(true);
    });

    it('detects a transitive cycle (a→b→c then c→a)', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      const b = createWorkItem({ project_id: projectId, title: 'B' });
      const c = createWorkItem({ project_id: projectId, title: 'C' });
      addLink({
        from_item_id: a.id, to_item_id: b.id,
        relation: 'parent_of', created_by: 'dashboard',
      });
      addLink({
        from_item_id: b.id, to_item_id: c.id,
        relation: 'parent_of', created_by: 'dashboard',
      });
      expect(wouldCreateParentCycle(c.id, a.id)).toBe(true);
    });

    it('addLink rejects parent_of cycles', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      const b = createWorkItem({ project_id: projectId, title: 'B' });
      addLink({
        from_item_id: a.id, to_item_id: b.id,
        relation: 'parent_of', created_by: 'dashboard',
      });
      expect(() => addLink({
        from_item_id: b.id, to_item_id: a.id,
        relation: 'parent_of', created_by: 'dashboard',
      })).toThrow(/cycle/i);
    });

    it('addLink rejects child_of cycles symmetrically', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      const b = createWorkItem({ project_id: projectId, title: 'B' });
      addLink({
        from_item_id: a.id, to_item_id: b.id,
        relation: 'parent_of', created_by: 'dashboard',
      });
      // a is already parent of b; adding "a child_of b" would mean b→a parent_of, cycle.
      expect(() => addLink({
        from_item_id: a.id, to_item_id: b.id,
        relation: 'child_of', created_by: 'dashboard',
      })).toThrow(/cycle/i);
    });
  });

  describe('parent_of position auto-assignment', () => {
    it('assigns incrementing positions to new children', () => {
      const parent = createWorkItem({ project_id: projectId, title: 'P' });
      const c1 = createWorkItem({ project_id: projectId, title: 'C1' });
      const c2 = createWorkItem({ project_id: projectId, title: 'C2' });
      const c3 = createWorkItem({ project_id: projectId, title: 'C3' });
      addLink({ from_item_id: parent.id, to_item_id: c1.id, relation: 'parent_of', created_by: 'dashboard' });
      addLink({ from_item_id: parent.id, to_item_id: c2.id, relation: 'parent_of', created_by: 'dashboard' });
      addLink({ from_item_id: parent.id, to_item_id: c3.id, relation: 'parent_of', created_by: 'dashboard' });

      const children = getChildItems(parent.id);
      expect(children).toHaveLength(3);
      expect(children[0].id).toBe(c1.id);
      expect(children[1].id).toBe(c2.id);
      expect(children[2].id).toBe(c3.id);
      expect(children[0].link_position).toBe(1);
      expect(children[1].link_position).toBe(2);
      expect(children[2].link_position).toBe(3);
    });
  });

  describe('reorderChildren', () => {
    it('updates positions in the supplied order', () => {
      const parent = createWorkItem({ project_id: projectId, title: 'P' });
      const c1 = createWorkItem({ project_id: projectId, title: 'C1' });
      const c2 = createWorkItem({ project_id: projectId, title: 'C2' });
      const c3 = createWorkItem({ project_id: projectId, title: 'C3' });
      for (const c of [c1, c2, c3]) {
        addLink({
          from_item_id: parent.id, to_item_id: c.id,
          relation: 'parent_of', created_by: 'dashboard',
        });
      }
      const changed = reorderChildren(parent.id, [c3.id, c1.id, c2.id], 'dashboard');
      expect(changed).toBe(3);

      const children = getChildItems(parent.id);
      expect(children.map((c) => c.id)).toEqual([c3.id, c1.id, c2.id]);
    });

    it('returns 0 for an empty order list', () => {
      const parent = createWorkItem({ project_id: projectId, title: 'P' });
      expect(reorderChildren(parent.id, [], 'dashboard')).toBe(0);
    });
  });

  describe('getParentItem', () => {
    it('returns null when item has no parent', () => {
      const a = createWorkItem({ project_id: projectId, title: 'Orphan' });
      expect(getParentItem(a.id)).toBeNull();
    });

    it('returns the parent via parent_of link', () => {
      const parent = createWorkItem({ project_id: projectId, title: 'P' });
      const child = createWorkItem({ project_id: projectId, title: 'C' });
      addLink({
        from_item_id: parent.id, to_item_id: child.id,
        relation: 'parent_of', created_by: 'dashboard',
      });
      const p = getParentItem(child.id);
      expect(p).not.toBeNull();
      expect(p!.id).toBe(parent.id);
    });
  });

  describe('getChildCountsBatch', () => {
    it('returns empty map when no parents given', () => {
      const m = getChildCountsBatch([]);
      expect(m.size).toBe(0);
    });

    it('buckets children by state correctly', () => {
      const parent = createWorkItem({ project_id: projectId, title: 'P' });
      const cDone1 = createWorkItem({ project_id: projectId, title: 'D1' });
      const cDone2 = createWorkItem({ project_id: projectId, title: 'D2' });
      const cInDev = createWorkItem({ project_id: projectId, title: 'InDev' });
      const cReview = createWorkItem({ project_id: projectId, title: 'InReview' });
      const cBrain = createWorkItem({ project_id: projectId, title: 'Brain' });
      const cCancelled = createWorkItem({ project_id: projectId, title: 'Cancelled' });

      changeWorkItemState(cDone1.id, 'done', 'dashboard');
      changeWorkItemState(cDone2.id, 'done', 'dashboard');
      changeWorkItemState(cInDev.id, 'in_development', 'dashboard');
      changeWorkItemState(cReview.id, 'in_review', 'dashboard');
      changeWorkItemState(cCancelled.id, 'cancelled', 'dashboard');

      for (const c of [cDone1, cDone2, cInDev, cReview, cBrain, cCancelled]) {
        addLink({
          from_item_id: parent.id, to_item_id: c.id,
          relation: 'parent_of', created_by: 'dashboard',
        });
      }

      const m = getChildCountsBatch([parent.id]);
      const counts = m.get(parent.id);
      expect(counts).toBeDefined();
      expect(counts!.total).toBe(6);
      expect(counts!.done).toBe(3); // 2 done + 1 cancelled
      expect(counts!.in_progress).toBe(2); // in_development + in_review
      expect(counts!.open).toBe(1); // brainstorming
    });

    it('omits parents with no children', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      const m = getChildCountsBatch([a.id]);
      expect(m.has(a.id)).toBe(false);
    });
  });

  describe('createGroupFromItems', () => {
    it('rejects fewer than 2 children', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      expect(() => createGroupFromItems({
        title: 'Group',
        child_item_ids: [a.id],
        created_by: 'dashboard',
      })).toThrow(/at least 2/i);
    });

    it('rejects empty title', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      const b = createWorkItem({ project_id: projectId, title: 'B' });
      expect(() => createGroupFromItems({
        title: '',
        child_item_ids: [a.id, b.id],
        created_by: 'dashboard',
      })).toThrow(/title is required/i);
    });

    it('creates a parent item with parent_of links to children', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      const b = createWorkItem({ project_id: projectId, title: 'B' });
      const c = createWorkItem({ project_id: projectId, title: 'C' });
      const parent = createGroupFromItems({
        title: 'My Group',
        description: 'Notes here',
        child_item_ids: [a.id, b.id, c.id],
        created_by: 'dashboard',
      });
      expect(parent).toBeDefined();
      expect(parent.title).toBe('My Group');
      expect(parent.description).toBe('Notes here');
      expect(parent.project_id).toBe(projectId);

      const children = getChildItems(parent.id);
      expect(children.map((c) => c.id).sort()).toEqual([a.id, b.id, c.id].sort());
    });

    it('skips children that would create a cycle (best-effort)', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      const b = createWorkItem({ project_id: projectId, title: 'B' });
      // Make a the parent of b first.
      addLink({
        from_item_id: a.id, to_item_id: b.id,
        relation: 'parent_of', created_by: 'dashboard',
      });
      // Now group [a, b] under a new parent — neither would cause a cycle.
      const c = createWorkItem({ project_id: projectId, title: 'C' });
      const parent = createGroupFromItems({
        title: 'Group',
        child_item_ids: [a.id, b.id, c.id],
        created_by: 'dashboard',
      });
      const children = getChildItems(parent.id);
      // All three should be linked (new parent doesn't create cycles).
      expect(children).toHaveLength(3);
    });

    it('deduplicates child IDs', () => {
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      const b = createWorkItem({ project_id: projectId, title: 'B' });
      const parent = createGroupFromItems({
        title: 'Group',
        child_item_ids: [a.id, a.id, b.id],
        created_by: 'dashboard',
      });
      const children = getChildItems(parent.id);
      expect(children).toHaveLength(2);
    });

    it('uses target_project_id when supplied', () => {
      const other = createProject({ name: 'Other', short_name: 'OT' });
      const a = createWorkItem({ project_id: projectId, title: 'A' });
      const b = createWorkItem({ project_id: projectId, title: 'B' });
      const parent = createGroupFromItems({
        title: 'X-project Group',
        child_item_ids: [a.id, b.id],
        target_project_id: other.id,
        created_by: 'dashboard',
      });
      expect(parent.project_id).toBe(other.id);
      const children = getChildItems(parent.id);
      expect(children).toHaveLength(2);
    });
  });
});

// ── Refactor Operations (TRACK-282) ─────────────────────────────────────────

describe('mergeItems (TRACK-282)', () => {
  let projectId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Merge Test', short_name: 'MT' });
    projectId = p.id;
  });

  it('moves comments, attachments, links and cancels sources', () => {
    const target = createWorkItem({
      project_id: projectId,
      title: 'Target',
      description: 'Original target body.',
    });
    const sourceA = createWorkItem({
      project_id: projectId,
      title: 'Source A',
      description: 'Body A',
    });
    const sourceB = createWorkItem({
      project_id: projectId,
      title: 'Source B',
      description: 'Body B',
    });

    createComment({ work_item_id: sourceA.id, author: 'alice', body: 'A1' });
    createComment({ work_item_id: sourceA.id, author: 'alice', body: 'A2' });
    createComment({ work_item_id: sourceB.id, author: 'bob', body: 'B1' });

    createAttachment({
      work_item_id: sourceA.id,
      filename: 'a.txt',
      mime_type: 'text/plain',
      size_bytes: 10,
      storage_path: '/tmp/a.txt',
    });

    // Outbound link from source A to a third item.
    const other = createWorkItem({ project_id: projectId, title: 'Other' });
    addLink({
      from_item_id: sourceA.id,
      to_item_id: other.id,
      relation: 'relates_to',
      created_by: 'dashboard',
    });

    const result = mergeItems({
      target_id: target.id,
      source_ids: [sourceA.id, sourceB.id],
      actor: 'dashboard',
    });

    expect(result.comments_moved).toBe(3);
    expect(result.attachments_moved).toBe(1);
    expect(result.sources_cancelled).toBe(2);
    expect(result.links_added).toBeGreaterThanOrEqual(2); // superseded_by * 2 + relates_to

    // Target has both source descriptions appended.
    const updatedTarget = getWorkItem(target.id)!;
    expect(updatedTarget.description).toContain('Merged from MT-2: Source A');
    expect(updatedTarget.description).toContain('Body A');
    expect(updatedTarget.description).toContain('Body B');

    // Sources cancelled.
    expect(getWorkItem(sourceA.id)!.state).toBe('cancelled');
    expect(getWorkItem(sourceB.id)!.state).toBe('cancelled');

    // Sources locked.
    expect(getWorkItem(sourceA.id)!.locked_by).toBe('dashboard');

    // Comments transferred to target with prefix.
    const targetComments = listComments(target.id);
    expect(targetComments).toHaveLength(3);
    expect(targetComments.every((c) => c.body.startsWith('[from MT-'))).toBe(true);

    // superseded_by link exists from each source to target.
    const linksFromA = listLinks(sourceA.id, 'superseded_by');
    expect(linksFromA.some((l) => l.other_item_id === target.id)).toBe(true);
  });

  it('snapshots target description into version history before edit', () => {
    const target = createWorkItem({
      project_id: projectId,
      title: 'Target',
      description: 'Original target body.',
    });
    const source = createWorkItem({ project_id: projectId, title: 'S', description: 'X' });

    const versionsBefore = listDescriptionVersions(target.id);
    mergeItems({ target_id: target.id, source_ids: [source.id], actor: 'dashboard' });
    const versionsAfter = listDescriptionVersions(target.id);

    expect(versionsAfter.length).toBe(versionsBefore.length + 1);
    expect(versionsAfter[versionsAfter.length - 1].description).toBe('Original target body.');
  });

  it('rolls back atomically on failure', () => {
    const target = createWorkItem({
      project_id: projectId,
      title: 'Target',
      description: 'orig',
    });
    const source = createWorkItem({ project_id: projectId, title: 'Source' });

    // Inject a source id that doesn't exist alongside a valid one — the
    // initial validation pass should throw and leave the DB untouched.
    expect(() => mergeItems({
      target_id: target.id,
      source_ids: [source.id, 'nonexistent-id'],
      actor: 'dashboard',
    })).toThrow();

    // Target description unchanged.
    expect(getWorkItem(target.id)!.description).toBe('orig');
    // Source unchanged.
    expect(getWorkItem(source.id)!.state).not.toBe('cancelled');
  });

  it('refuses merges from api-class actors', () => {
    const target = createWorkItem({ project_id: projectId, title: 'T' });
    const source = createWorkItem({ project_id: projectId, title: 'S' });
    expect(() => mergeItems({
      target_id: target.id,
      source_ids: [source.id],
      actor: 'unknown-bot',
    })).toThrow(/cannot perform merges/i);
  });

  it('refuses to merge a locked source not owned by the actor', () => {
    const target = createWorkItem({ project_id: projectId, title: 'T' });
    const source = createWorkItem({ project_id: projectId, title: 'S' });
    lockWorkItem(source.id, 'OtherAgent');
    expect(() => mergeItems({
      target_id: target.id,
      source_ids: [source.id],
      actor: 'dashboard',
    })).toThrow(/locked by OtherAgent/);
  });

  it('refuses to merge an item into itself', () => {
    const t = createWorkItem({ project_id: projectId, title: 'T' });
    expect(() => mergeItems({
      target_id: t.id,
      source_ids: [t.id],
      actor: 'dashboard',
    })).toThrow(/itself/i);
  });

  it('agent actor can perform a merge', () => {
    const target = createWorkItem({ project_id: projectId, title: 'T' });
    const source = createWorkItem({ project_id: projectId, title: 'S' });
    const result = mergeItems({
      target_id: target.id,
      source_ids: [source.id],
      actor: 'Coder',
    });
    expect(result.sources_cancelled).toBe(1);
    expect(getWorkItem(source.id)!.state).toBe('cancelled');
  });

  it('writes a composite activity_log entry', () => {
    const target = createWorkItem({ project_id: projectId, title: 'T' });
    const source = createWorkItem({ project_id: projectId, title: 'S' });
    mergeItems({
      target_id: target.id,
      source_ids: [source.id],
      actor: 'dashboard',
    });
    const entries = listActivity({ action: 'items.merged' });
    expect(entries.length).toBeGreaterThan(0);
    const raw = entries[0].details;
    const details = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(details.target_key).toBe('MT-1');
    expect(details.source_keys).toEqual(['MT-2']);
  });
});

describe('splitItem (TRACK-282)', () => {
  let projectId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Split Test', short_name: 'ST' });
    projectId = p.id;
  });

  it('creates new items linked via parent_of', () => {
    const source = createWorkItem({
      project_id: projectId,
      title: 'Source',
      description: 'original body',
    });
    const result = splitItem({
      source_id: source.id,
      splits: [
        { title: 'Part one', description: 'one' },
        { title: 'Part two', description: 'two' },
        { title: 'Part three' },
      ],
      actor: 'dashboard',
    });

    expect(result.created).toHaveLength(3);

    const children = getChildItems(source.id);
    expect(children).toHaveLength(3);
    expect(children.map((c) => c.title).sort()).toEqual(['Part one', 'Part three', 'Part two']);
  });

  it('moves comments matching the regex per split', () => {
    const source = createWorkItem({ project_id: projectId, title: 'Source' });
    createComment({ work_item_id: source.id, author: 'a', body: 'frontend bug' });
    createComment({ work_item_id: source.id, author: 'a', body: 'backend issue' });
    createComment({ work_item_id: source.id, author: 'a', body: 'unrelated' });

    const result = splitItem({
      source_id: source.id,
      splits: [
        { title: 'Frontend', take_comments_matching: 'frontend' },
        { title: 'Backend', take_comments_matching: 'backend' },
      ],
      actor: 'dashboard',
    });

    expect(result.created[0].comments_taken).toBe(1);
    expect(result.created[1].comments_taken).toBe(1);

    // Source still has the unrelated comment.
    expect(listComments(source.id)).toHaveLength(1);
    expect(listComments(result.created[0].id)[0].body).toBe('frontend bug');
    expect(listComments(result.created[1].id)[0].body).toBe('backend issue');
  });

  it('preserves source by default', () => {
    const source = createWorkItem({ project_id: projectId, title: 'Source' });
    splitItem({
      source_id: source.id,
      splits: [{ title: 'Child' }],
      actor: 'dashboard',
    });
    expect(getWorkItem(source.id)!.state).not.toBe('cancelled');
  });

  it('cancels source and writes stub when preserve_source=false', () => {
    const source = createWorkItem({
      project_id: projectId,
      title: 'Source',
      description: 'original',
    });
    const result = splitItem({
      source_id: source.id,
      splits: [{ title: 'A' }, { title: 'B' }],
      preserve_source: false,
      actor: 'dashboard',
    });
    const updated = getWorkItem(source.id)!;
    expect(updated.state).toBe('cancelled');
    expect(updated.description).toContain('Split into');
    expect(updated.description).toContain(result.created[0].key);
  });

  it('snapshots source description before edit', () => {
    const source = createWorkItem({
      project_id: projectId,
      title: 'Source',
      description: 'original body',
    });
    splitItem({
      source_id: source.id,
      splits: [{ title: 'X' }],
      preserve_source: false,
      actor: 'dashboard',
    });
    const versions = listDescriptionVersions(source.id);
    expect(versions.some((v) => v.description === 'original body')).toBe(true);
  });

  it('refuses invalid regex', () => {
    const source = createWorkItem({ project_id: projectId, title: 'S' });
    expect(() => splitItem({
      source_id: source.id,
      splits: [{ title: 'X', take_comments_matching: '[invalid' }],
      actor: 'dashboard',
    })).toThrow(/regex/i);
  });

  it('refuses splits from api-class actors', () => {
    const source = createWorkItem({ project_id: projectId, title: 'S' });
    expect(() => splitItem({
      source_id: source.id,
      splits: [{ title: 'X' }],
      actor: 'unknown',
    })).toThrow(/cannot perform splits/i);
  });
});

describe('bulkUpdate (TRACK-282)', () => {
  let projectId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Bulk Test', short_name: 'BT' });
    projectId = p.id;
  });

  it('updates priority on many items', () => {
    const items = [1, 2, 3].map((n) =>
      createWorkItem({ project_id: projectId, title: `Item ${n}` }),
    );
    const result = bulkUpdate({
      item_ids: items.map((i) => i.id),
      patch: { priority: 'high' },
      actor: 'dashboard',
    });
    expect(result.updated).toBe(3);
    for (const i of items) {
      expect(getWorkItem(i.id)!.priority).toBe('high');
    }
  });

  it('adds and removes labels with set semantics', () => {
    const a = createWorkItem({
      project_id: projectId,
      title: 'A',
      labels: ['old', 'keep'],
    });
    const b = createWorkItem({
      project_id: projectId,
      title: 'B',
      labels: ['old'],
    });
    bulkUpdate({
      item_ids: [a.id, b.id],
      patch: { labels: { add: ['new'], remove: ['old'] } },
      actor: 'dashboard',
    });
    const aL = JSON.parse(getWorkItem(a.id)!.labels as unknown as string);
    const bL = JSON.parse(getWorkItem(b.id)!.labels as unknown as string);
    expect(aL).toEqual(expect.arrayContaining(['keep', 'new']));
    expect(aL).not.toContain('old');
    expect(bL).toContain('new');
    expect(bL).not.toContain('old');
  });

  it('blocks agent actor from bulk-approving', () => {
    const items = [1, 2].map((n) =>
      createWorkItem({
        project_id: projectId,
        title: `Item ${n}`,
        requires_code: true,
      }),
    );
    const result = bulkUpdate({
      item_ids: items.map((i) => i.id),
      patch: { state: 'approved' },
      actor: 'Coder',
    });
    expect(result.updated).toBe(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toMatch(/human|approve/i);
  });

  it('moves items to another project', () => {
    const other = createProject({ name: 'Other', short_name: 'OB' });
    const items = [1, 2].map((n) =>
      createWorkItem({ project_id: projectId, title: `Item ${n}` }),
    );
    const result = bulkUpdate({
      item_ids: items.map((i) => i.id),
      patch: { project_id: other.id },
      actor: 'dashboard',
    });
    expect(result.updated).toBe(2);
    for (const i of items) {
      expect(getWorkItem(i.id)!.project_id).toBe(other.id);
    }
  });

  it('skips items locked by another agent', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const b = createWorkItem({ project_id: projectId, title: 'B' });
    lockWorkItem(b.id, 'OtherAgent');

    const result = bulkUpdate({
      item_ids: [a.id, b.id],
      patch: { priority: 'high' },
      actor: 'dashboard',
    });
    expect(result.updated).toBe(1);
    expect(result.skipped[0].id).toBe(b.id);
    expect(result.skipped[0].reason).toMatch(/locked/);
  });

  it('refuses bulk updates from api-class actors', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    expect(() => bulkUpdate({
      item_ids: [a.id],
      patch: { priority: 'low' },
      actor: 'random',
    })).toThrow(/cannot perform bulk updates/i);
  });

  it('reports no-op items as skipped', () => {
    const a = createWorkItem({
      project_id: projectId,
      title: 'A',
      priority: 'high',
    });
    const result = bulkUpdate({
      item_ids: [a.id],
      patch: { priority: 'high' },
      actor: 'dashboard',
    });
    expect(result.updated).toBe(0);
    expect(result.skipped[0].reason).toMatch(/no-op/);
  });

  it('writes a composite activity_log entry', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    bulkUpdate({
      item_ids: [a.id],
      patch: { priority: 'high' },
      actor: 'dashboard',
    });
    const entries = listActivity({ action: 'items.bulk_updated' });
    expect(entries.length).toBeGreaterThan(0);
  });
});

// ── Proposals (TRACK-284) ─────────────────────────────────────────────────────

describe('Proposals (TRACK-284)', () => {
  let projectId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Prop Test', short_name: 'PT' });
    projectId = p.id;
  });

  it('creates a proposal with multiple actions', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const result = createProposal({
      title: 'Tidy up',
      summary: 'Clean up labels',
      proposed_by: 'Harmoni',
      actions: [
        {
          kind: 'update_item',
          payload: { item_id: a.id, priority: 'high' },
          rationale: 'High urgency',
        },
        {
          kind: 'bulk_update',
          payload: { item_ids: [a.id], patch: { labels: { add: ['triaged'] } } },
        },
      ],
    });
    expect(result.proposal.status).toBe('pending');
    expect(result.proposal.proposed_by_class).toBe('agent');
    expect(result.actions.length).toBe(2);
    expect(result.actions[0].ordinal).toBe(0);
    expect(result.actions[1].ordinal).toBe(1);
  });

  it('rejects unknown action kind', () => {
    expect(() =>
      createProposal({
        title: 'bad',
        proposed_by: 'Harmoni',
        actions: [{ kind: 'launch_nukes', payload: {} }],
      }),
    ).toThrow(/Invalid action kind/);
  });

  it('rejects empty actions array', () => {
    expect(() =>
      createProposal({ title: 'empty', proposed_by: 'Harmoni', actions: [] }),
    ).toThrow();
  });

  it('only allows human actors to apply', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const { proposal, actions } = createProposal({
      title: 't',
      proposed_by: 'Harmoni',
      actions: [{ kind: 'update_item', payload: { item_id: a.id, priority: 'high' } }],
    });
    setProposalActionStatus({ action_id: actions[0].id, status: 'accepted', actor: 'dashboard' });
    expect(() => applyProposal({ proposal_id: proposal.id, actor: 'Harmoni' })).toThrow(/human/);
    expect(() => applyProposal({ proposal_id: proposal.id, actor: 'orchestrator' })).toThrow(/human/);
  });

  it('applies accepted actions only', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const b = createWorkItem({ project_id: projectId, title: 'B' });
    const { proposal, actions } = createProposal({
      title: 'mixed',
      proposed_by: 'Harmoni',
      actions: [
        { kind: 'update_item', payload: { item_id: a.id, priority: 'high' } },
        { kind: 'update_item', payload: { item_id: b.id, priority: 'urgent' } },
      ],
    });
    // Accept only the first
    setProposalActionStatus({ action_id: actions[0].id, status: 'accepted', actor: 'dashboard' });
    const result = applyProposal({ proposal_id: proposal.id, actor: 'dashboard' });
    expect(result.applied_count).toBe(1);
    expect(result.failed_count).toBe(0);
    expect(getWorkItem(a.id)!.priority).toBe('high');
    expect(getWorkItem(b.id)!.priority).not.toBe('urgent');
    // Proposal is partially_applied because one action ran but the other is still pending
    expect(result.proposal_status).toBe('partially_applied');
  });

  it('routes to mutators and preserves agent-cannot-approve rule', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A', requires_code: true });
    const { proposal, actions } = createProposal({
      title: 'try to approve',
      proposed_by: 'Harmoni',
      actions: [
        { kind: 'change_state', payload: { item_id: a.id, state: 'brainstorming' } },
        { kind: 'change_state', payload: { item_id: a.id, state: 'approved' } },
      ],
    });
    setProposalActionStatus({ action_id: actions[0].id, status: 'accepted', actor: 'dashboard' });
    setProposalActionStatus({ action_id: actions[1].id, status: 'accepted', actor: 'dashboard' });
    // applyProposal uses actor='dashboard' (human) so changeWorkItemState will allow approval
    const result = applyProposal({ proposal_id: proposal.id, actor: 'dashboard' });
    expect(result.applied_count).toBe(2);
    expect(getWorkItem(a.id)!.state).toBe('approved');
  });

  it('captures per-action errors without aborting the batch', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const { proposal, actions } = createProposal({
      title: 'partial',
      proposed_by: 'Harmoni',
      actions: [
        { kind: 'update_item', payload: { item_id: a.id, priority: 'high' } },
        { kind: 'update_item', payload: { item_id: 'NONEXISTENT-9999', priority: 'high' } },
      ],
    });
    setProposalActionStatus({ action_id: actions[0].id, status: 'accepted', actor: 'dashboard' });
    setProposalActionStatus({ action_id: actions[1].id, status: 'accepted', actor: 'dashboard' });
    const result = applyProposal({ proposal_id: proposal.id, actor: 'dashboard' });
    expect(result.applied_count).toBe(1);
    expect(result.failed_count).toBe(1);
    expect(result.proposal_status).toBe('partially_applied');
    expect(getWorkItem(a.id)!.priority).toBe('high');
  });

  it('is idempotent on re-apply (skips already-applied actions)', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const { proposal, actions } = createProposal({
      title: 'idem',
      proposed_by: 'Harmoni',
      actions: [{ kind: 'update_item', payload: { item_id: a.id, priority: 'high' } }],
    });
    setProposalActionStatus({ action_id: actions[0].id, status: 'accepted', actor: 'dashboard' });
    const first = applyProposal({ proposal_id: proposal.id, actor: 'dashboard' });
    expect(first.applied_count).toBe(1);
    const second = applyProposal({
      proposal_id: proposal.id,
      action_ids: [actions[0].id],
      actor: 'dashboard',
    });
    expect(second.applied_count).toBe(0);
    expect(second.skipped_count).toBe(1);
  });

  it('rejects a proposal and cancels remaining actions', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const { proposal } = createProposal({
      title: 'rej',
      proposed_by: 'Harmoni',
      actions: [{ kind: 'update_item', payload: { item_id: a.id, priority: 'high' } }],
    });
    rejectProposal({ proposal_id: proposal.id, actor: 'dashboard' });
    const after = getProposal(proposal.id);
    expect(after!.status).toBe('rejected');
    const actions = getProposalActions(proposal.id);
    expect(actions[0].status).toBe('rejected');
  });

  it('cannot apply a rejected proposal', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const { proposal } = createProposal({
      title: 'rej',
      proposed_by: 'Harmoni',
      actions: [{ kind: 'update_item', payload: { item_id: a.id, priority: 'high' } }],
    });
    rejectProposal({ proposal_id: proposal.id, actor: 'dashboard' });
    expect(() => applyProposal({ proposal_id: proposal.id, actor: 'dashboard' })).toThrow(/rejected/);
  });

  it('expires overdue proposals via expireOverdueProposals()', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const { proposal } = createProposal({
      title: 'old',
      proposed_by: 'Harmoni',
      actions: [{ kind: 'update_item', payload: { item_id: a.id, priority: 'high' } }],
    });
    _setProposalExpiresAtForTest(proposal.id, '2020-01-01T00:00:00.000Z');
    const expired = expireOverdueProposals();
    expect(expired).toContain(proposal.id);
    expect(getProposal(proposal.id)!.status).toBe('expired');
  });

  it('does not expire proposals with expires_at in the future', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const { proposal } = createProposal({
      title: 'fresh',
      proposed_by: 'Harmoni',
      expires_in_days: 7,
      actions: [{ kind: 'update_item', payload: { item_id: a.id, priority: 'high' } }],
    });
    const expired = expireOverdueProposals();
    expect(expired).not.toContain(proposal.id);
    expect(getProposal(proposal.id)!.status).toBe('pending');
  });

  it('does not expire applied or rejected proposals', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const { proposal, actions } = createProposal({
      title: 'done',
      proposed_by: 'Harmoni',
      actions: [{ kind: 'update_item', payload: { item_id: a.id, priority: 'high' } }],
    });
    setProposalActionStatus({ action_id: actions[0].id, status: 'accepted', actor: 'dashboard' });
    applyProposal({ proposal_id: proposal.id, actor: 'dashboard' });
    _setProposalExpiresAtForTest(proposal.id, '2020-01-01T00:00:00.000Z');
    const expired = expireOverdueProposals();
    expect(expired).not.toContain(proposal.id);
    expect(getProposal(proposal.id)!.status).toBe('applied');
  });

  it('lists proposals with status filter and exposes stats', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const p1 = createProposal({
      title: 'p1',
      proposed_by: 'Harmoni',
      actions: [{ kind: 'update_item', payload: { item_id: a.id, priority: 'high' } }],
    });
    rejectProposal({ proposal_id: p1.proposal.id, actor: 'dashboard' });
    createProposal({
      title: 'p2',
      proposed_by: 'Harmoni',
      actions: [{ kind: 'update_item', payload: { item_id: a.id, priority: 'urgent' } }],
    });
    const pending = listProposals({ status: 'pending' });
    expect(pending.length).toBe(1);
    expect(pending[0].title).toBe('p2');
    const rejected = listProposals({ status: 'rejected' });
    expect(rejected.length).toBe(1);
    const stats = getProposalStats();
    expect(stats.pending).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.total).toBe(2);
  });

  it('records activity log entries for create, reject and apply', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const { proposal, actions } = createProposal({
      title: 'audit',
      proposed_by: 'Harmoni',
      actions: [{ kind: 'update_item', payload: { item_id: a.id, priority: 'high' } }],
    });
    setProposalActionStatus({ action_id: actions[0].id, status: 'accepted', actor: 'dashboard' });
    applyProposal({ proposal_id: proposal.id, actor: 'dashboard' });
    const created = listActivity({ action: 'proposal.created' });
    const applied = listActivity({ action: 'proposal.applied' });
    expect(created.length).toBeGreaterThan(0);
    expect(applied.length).toBeGreaterThan(0);
  });

  it('applies add_link with source="proposal"', () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' });
    const b = createWorkItem({ project_id: projectId, title: 'B' });
    const { proposal, actions } = createProposal({
      title: 'link',
      proposed_by: 'Harmoni',
      actions: [
        {
          kind: 'add_link',
          payload: { from_item_id: a.id, to_item_id: b.id, relation: 'relates_to' },
        },
      ],
    });
    setProposalActionStatus({ action_id: actions[0].id, status: 'accepted', actor: 'dashboard' });
    const result = applyProposal({ proposal_id: proposal.id, actor: 'dashboard' });
    expect(result.applied_count).toBe(1);
    const links = listLinks(a.id);
    const proposalLink = links.find((l) => l.source === 'proposal');
    expect(proposalLink).toBeDefined();
  });
});

// ── Session counts (TRACK-291) ──────────────────────────────────────────────
describe('Session counts (TRACK-291)', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  // Three audits per item: one with a transcript, one with an empty transcript
  // (NULL after coerce), and one still pending. Only the one with a real
  // transcript should count — that's what the Sessions tab actually renders.
  function seedAudits(workItemId: string, transcripts: (string | null)[]): void {
    transcripts.forEach((t, idx) => {
      const sessionId = `sess_${workItemId}_${idx}`;
      createExecutionAudit({ work_item_id: workItemId, session_id: sessionId });
      if (t !== null) {
        completeExecutionAudit(sessionId, { exit_status: 'success', transcript: t });
      }
    });
  }

  it('countExecutionAuditsWithTranscript only counts audits whose transcript is non-NULL', () => {
    const proj = createProject({ name: 'p', short_name: 'P', description: '' });
    const item = createWorkItem({
      project_id: proj.id,
      title: 'item',
      description: '',
      created_by: 'dashboard',
    });
    seedAudits(item.id, ['{"events":[]}', null, '{"events":["hi"]}']);
    expect(countExecutionAuditsWithTranscript(item.id)).toBe(2);
  });

  it('getSessionCountsBatch returns a map keyed by work_item_id, skipping items with zero', () => {
    const proj = createProject({ name: 'p', short_name: 'P', description: '' });
    const itemA = createWorkItem({
      project_id: proj.id,
      title: 'a',
      description: '',
      created_by: 'dashboard',
    });
    const itemB = createWorkItem({
      project_id: proj.id,
      title: 'b',
      description: '',
      created_by: 'dashboard',
    });
    const itemC = createWorkItem({
      project_id: proj.id,
      title: 'c',
      description: '',
      created_by: 'dashboard',
    });
    seedAudits(itemA.id, ['{"events":[]}', '{"events":[]}']); // 2 transcripts
    seedAudits(itemB.id, [null, null]);                       // 0 transcripts (pending)
    // itemC: no audits at all                                 // 0 transcripts

    const counts = getSessionCountsBatch([itemA.id, itemB.id, itemC.id]);
    expect(counts[itemA.id]).toBe(2);
    expect(counts[itemB.id]).toBeUndefined();
    expect(counts[itemC.id]).toBeUndefined();
  });

  it('getSessionCountsBatch returns an empty object for an empty input', () => {
    expect(getSessionCountsBatch([])).toEqual({});
  });
});
