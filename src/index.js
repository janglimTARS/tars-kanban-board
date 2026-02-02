export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const authHeader = request.headers.get('Authorization');
    const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const isAuthed = apiKey === env.API_KEY;

    // Serve frontend
    if (url.pathname === '/') {
      return new Response(HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    }

    // API routes require auth
    if (url.pathname.startsWith('/api/') && !isAuthed) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Tasks API
    if (url.pathname.startsWith('/api/tasks')) {
      const id = url.pathname.split('/')[3];
      if (request.method === 'GET') {
        if (id) {
          const data = await env.TASKS_KV.get(`task:${id}`);
          return data ? Response.json(JSON.parse(data)) : new Response('Not Found', {status: 404});
        } else {
          return Response.json(await getAll(env.TASKS_KV, 'task:'));
        }
      } else if (request.method === 'POST') {
        const data = await request.json();
        await env.TASKS_KV.put(`task:${data.id}`, JSON.stringify(data));
        return Response.json(data, {status: 201});
      } else if (request.method === 'PUT' && id) {
        const data = await request.json();
        if (data.id !== id) return new Response('ID mismatch', {status: 400});
        await env.TASKS_KV.put(`task:${id}`, JSON.stringify(data));
        return Response.json(data);
      } else if (request.method === 'DELETE' && id) {
        await env.TASKS_KV.delete(`task:${id}`);
        return new Response('Deleted');
      }
    }

    // Subagents API
    if (url.pathname.startsWith('/api/subagents')) {
      const id = url.pathname.split('/')[3];
      if (request.method === 'GET') {
        if (id) {
          const data = await env.SUBAGENTS_KV.get(`subagent:${id}`);
          return data ? Response.json(JSON.parse(data)) : new Response('Not Found', {status: 404});
        } else {
          return Response.json(await getAll(env.SUBAGENTS_KV, 'subagent:'));
        }
      } else if (request.method === 'POST') {
        const data = await request.json();
        await env.SUBAGENTS_KV.put(`subagent:${data.id}`, JSON.stringify(data));
        return Response.json(data, {status: 201});
      } else if (request.method === 'PUT' && id) {
        const data = await request.json();
        if (data.id !== id) return new Response('ID mismatch', {status: 400});
        await env.SUBAGENTS_KV.put(`subagent:${id}`, JSON.stringify(data));
        return Response.json(data);
      } else if (request.method === 'DELETE' && id) {
        await env.SUBAGENTS_KV.delete(`subagent:${id}`);
        return new Response('Deleted');
      }
    }

    // Spawn subagent (mocks for now, integrate OpenClaw)
    if (url.pathname === '/api/spawn' && request.method === 'POST') {
      const { taskId } = await request.json();
      const taskKey = `task:${taskId}`;
      const taskJson = await env.TASKS_KV.get(taskKey);
      if (!taskJson) return new Response('Task not found', {status: 404});

      const task = JSON.parse(taskJson);
      const subId = crypto.randomUUID();
      const subagent = {
        id: subId,
        status: 'running',
        taskId,
        started: Date.now(),
      };
      await env.SUBAGENTS_KV.put(`subagent:${subId}`, JSON.stringify(subagent));

      task.assigned = subId;
      task.status = 'inprogress';
      if (!task.history) task.history = [];
      task.history.push({ ts: Date.now(), event: 'spawned', log: `Subagent ${subId} spawned via Kanban.` });
      task.updated = Date.now();
      await env.TASKS_KV.put(taskKey, JSON.stringify(task));

      /*
      // UNCOMMENT AND CONFIGURE FOR REAL OPENCLAW INTEGRATION
      try {
        const res = await fetch(`${env.OPENCLAW_API}/spawn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId,
            instructions: task.desc || task.title,
            webhook: new URL('/api/webhook', request.url).toString(),
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const subId = data.subagentId || data.id;
        // update subagent and task as above
      } catch (e) {
        return new Response(`Spawn failed: ${e.message}`, {status: 500});
      }
      */

      return Response.json({ subagentId: subId });
    }

    // Manage subagent
    if (url.pathname.startsWith('/api/manage/') && request.method === 'POST') {
      const subId = url.pathname.split('/')[3];
      const { action } = await request.json();
      const subKey = `subagent:${subId}`;
      const subJson = await env.SUBAGENTS_KV.get(subKey);
      if (!subJson) return new Response('Subagent not found', {status: 404});
      const sub = JSON.parse(subJson);
      if (action === 'kill') {
        sub.status = 'failed';
        sub.finished = Date.now();
        await env.SUBAGENTS_KV.put(subKey, JSON.stringify(sub));

        // Update task
        const taskJson = await env.TASKS_KV.get(`task:${sub.taskId}`);
        if (taskJson) {
          const task = JSON.parse(taskJson);
          if (!task.history) task.history = [];
          task.history.push({ ts: Date.now(), event: 'killed', log: `Subagent ${subId} killed.` });
          task.updated = Date.now();
          await env.TASKS_KV.put(`task:${sub.taskId}`, JSON.stringify(task));
        }
      }
      return Response.json(sub);
    }

    // Webhook for subagent updates (no auth for simplicity, add secret if needed)
    if (url.pathname === '/api/webhook' && request.method === 'POST') {
      const body = await request.json();
      const { taskId, subagentId, status, log = '' } = body;

      if (taskId) {
        const taskJson = await env.TASKS_KV.get(`task:${taskId}`);
        if (taskJson) {
          const task = JSON.parse(taskJson);
          if (!task.history) task.history = [];
          task.history.push({ ts: Date.now(), event: status, log });
          if (status === 'completed' || status === 'failed') {
            task.status = 'done';
          }
          task.updated = Date.now();
          await env.TASKS_KV.put(`task:${taskId}`, JSON.stringify(task));
        }
      }

      if (subagentId) {
        const subJson = await env.SUBAGENTS_KV.get(`subagent:${subagentId}`);
        if (subJson) {
          const sub = JSON.parse(subJson);
          sub.status = status;
          sub.finished = Date.now();
          await env.SUBAGENTS_KV.put(`subagent:${subagentId}`, JSON.stringify(sub));
        }
      }

      return new Response('OK', { status: 200 });
    }

    return new Response(HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  },
};

async function getAll(kv, prefix) {
  const { keys } = await kv.list({ prefix });
  const items = await Promise.all(
    keys.map(async (k) => {
      const value = await kv.get(k.name);
      return value ? JSON.parse(value) : null;
    })
  );
  return items.filter(Boolean);
}

const HTML = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kanban Board</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0a0a;
      --surface: #1e1e2e;
      --surface-hover: #27293d;
      --text: #f8f9fa;
      --text-secondary: #a0a0a0;
      --border: rgba(255,255,255,0.1);
      --accent: #5b8def;
      --accent-hover: #4d7be2;
      --success: #238636;
      --warning: #bb8009;
      --error: #da3633;
      --radius: 12px;
    }
    * {
      box-sizing: border-box;
    }
    body {
      font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
      font-size: 15px;
      line-height: 1.6;
      font-weight: 400;
      letter-spacing: -0.01em;
    }
    h1, h2, h3, h4 {
      font-weight: 600;
      line-height: 1.25;
    }
    .text-caption {
      font-size: 0.875rem;
      color: var(--text-secondary);
    }
  </style>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-[var(--bg)] text-[var(--text)] min-h-screen p-8 antialiased overflow-x-auto">

  <!-- Login Modal -->
  <div id="loginModal" class="fixed inset-0 bg-black/40 backdrop-blur-md flex items-center justify-center z-50 hidden">
    <div class="bg-[var(--surface)] border border-[var(--border)] p-6 rounded-xl shadow-md max-w-sm w-full mx-4">
      <h2 class="text-xl font-bold text-[var(--text)] mb-6 text-center">Authenticate</h2>
      <input id="apiKeyInput" type="password" placeholder="API key" class="w-full bg-[var(--surface)] border border-[var(--border)] p-3 rounded-lg text-sm placeholder:text-[var(--text-secondary)] mb-4 focus:outline-none focus:ring-2 ring-[var(--accent)]/50 focus:border-[var(--accent)] transition-all">
      <button onclick="login()" class="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--text)] font-semibold py-3 px-6 rounded-lg shadow-sm hover:shadow-md transition-all">
        Enter Board
      </button>
    </div>
  </div>

  <!-- Main App -->
  <div id="app" class="hidden max-w-7xl mx-auto">
    <header class="sticky top-0 z-40 bg-[var(--bg)]/95 backdrop-blur-sm flex flex-col lg:flex-row justify-between items-start lg:items-center mb-12 gap-6 pt-8 pb-6 rounded-b-xl shadow-lg border-b border-[var(--border)] -mx-8 px-8 lg:-mx-0 lg:px-0 lg:rounded-none">
      <h1 class="text-3xl lg:text-4xl font-bold text-[var(--text)]">
        Kanban Board
      </h1>
      <div class="flex items-center gap-4">
        <select id="viewSelect" class="bg-[var(--surface)] border border-[var(--border)] px-4 py-2 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 ring-[var(--accent)]/50 focus:border-[var(--accent)]">
          <option value="kanban">Kanban</option>
          <option value="dashboard">Subagents</option>
        </select>
        <input id="searchInput" type="text" placeholder="Search tasks..." class="flex-1 max-w-sm min-w-[250px] bg-[var(--surface)] border border-[var(--border)] px-4 py-2 rounded-lg placeholder:text-[var(--text-secondary)] text-sm focus:outline-none focus:ring-2 ring-[var(--accent)]/50 focus:border-[var(--accent)]">
        <button onclick="addNewTask()" class="bg-[var(--success)] hover:bg-[var(--success)]/90 text-white px-6 py-3 rounded-xl font-semibold shadow-sm hover:shadow-md transition-all min-w-[120px]">+ New Task</button>
        <button onclick="logout()" class="bg-red-600 hover:bg-red-500 px-6 py-3 rounded-xl font-bold shadow-lg transition-all">Logout</button>
      </div>
    </header>

    <!-- Kanban View -->
    <div id="kanbanView" class="flex gap-6 pb-12 flex-wrap lg:flex-nowrap overflow-x-auto -mr-8 pr-8 lg:mr-0 lg:pr-0 scrollbar-thin scrollbar-thumb-[var(--surface)] scrollbar-track-transparent">
      <div class="column flex-1 min-w-[320px]" data-status="todo">
        <h2 class="text-2xl font-semibold text-[var(--text)] mb-6 pb-2.5 border-b border-[var(--border)] text-center">To Do</h2>
        <div class="cards min-h-[400px] space-y-4"></div>
      </div>
      <div class="column flex-1 min-w-[320px]" data-status="inprogress">
        <h2 class="text-2xl font-semibold text-[var(--text)] mb-6 pb-2.5 border-b border-[var(--border)] text-center">In Progress</h2>
        <div class="cards min-h-[400px] space-y-4"></div>
      </div>
      <div class="column flex-1 min-w-[320px]" data-status="done">
        <h2 class="text-2xl font-semibold text-[var(--text)] mb-6 pb-2.5 border-b border-[var(--border)] text-center">Done</h2>
        <div class="cards min-h-[400px] space-y-4"></div>
      </div>
    </div>

    <!-- Dashboard View -->
    <div id="dashboardView" class="hidden">
      <h2 class="text-3xl font-semibold text-[var(--text)] mb-12">Active Subagents</h2>
      <div id="subagentList" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"></div>
    </div>
  </div>

  <!-- Task Edit Modal -->
  <dialog id="taskModal" class="backdrop:bg-black/50 p-0 m-0 backdrop:backdrop-blur-sm">
    <div class="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 max-w-2xl w-11/12 mx-auto max-h-[90vh] overflow-y-auto shadow-lg">
      <h3 id="modalTitle" class="text-xl font-semibold text-[var(--text)] mb-6">New Task</h3>
      <input id="taskTitleInput" placeholder="Task Title" class="w-full bg-[var(--surface)] border border-[var(--border)] p-3 rounded-lg mb-4 text-base focus:outline-none focus:ring-2 ring-[var(--accent)]/50 focus:border-[var(--accent)] placeholder:text-[var(--text-secondary)]">
      <textarea id="taskDescInput" placeholder="Description / Instructions for subagent" class="w-full bg-[var(--surface)] border border-[var(--border)] p-3 rounded-lg mb-4 h-28 resize-vertical focus:outline-none focus:ring-2 ring-[var(--accent)]/50 focus:border-[var(--accent)] placeholder:text-[var(--text-secondary)]"></textarea>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <select id="taskPrioritySelect" class="bg-[var(--surface)] border border-[var(--border)] p-3 rounded-lg text-sm">
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <input id="taskSubagentInput" placeholder="Subagent ID (optional)" class="bg-[var(--surface)] border border-[var(--border)] p-3 rounded-lg text-sm placeholder:text-[var(--text-secondary)] focus:outline-none focus:ring-2 ring-[var(--accent)]/50 focus:border-[var(--accent)]">
      </div>
      <div class="flex flex-wrap gap-3 justify-end">
        <button id="spawnButton" onclick="spawnSubagentForCurrent()" class="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 px-6 py-3 rounded-xl font-bold shadow-lg transition-all">🚀 Spawn Subagent</button>
        <button onclick="saveCurrentTask()" class="bg-green-600 hover:bg-green-500 px-6 py-3 rounded-xl font-bold shadow-lg transition-all">💾 Save</button>
        <button onclick="deleteCurrentTask()" class="bg-red-600 hover:bg-red-500 px-6 py-3 rounded-xl font-bold shadow-lg transition-all">🗑️ Delete</button>
        <button onclick="closeTaskModal()" class="bg-gray-600 hover:bg-gray-500 px-6 py-3 rounded-xl font-bold transition-all">❌ Cancel</button>
      </div>
    </div>
  </dialog>

  <!-- History Modal -->
  <dialog id="historyModal" class="backdrop:bg-black/80 p-0 m-0 backdrop:backdrop-blur-md">
    <div class="bg-gray-900/95 border border-gray-700 rounded-3xl p-8 max-w-4xl w-full mx-4 max-h-[90vh] overflow-y-auto shadow-2xl">
      <h3 id="historyTitle" class="text-2xl font-semibold mb-6 text-[var(--accent)]">Task History</h3>
      <div id="historyContent" class="space-y-3 mb-8 text-sm"></div>
      <button onclick="closeHistoryModal()" class="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 py-4 px-8 rounded-xl font-bold text-lg shadow-lg transition-all">Close</button>
    </div>
  </dialog>

  <script>
    const API_BASE = location.origin;
    let apiKey = localStorage.getItem('tarsApiKey') || '';
    let tasks = [];
    let subagents = [];
    let currentTaskId = null;
    let isEditing = false;
    let pollInterval = null;

    // Init
    if (apiKey) {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('loginModal').classList.add('hidden');
      initApp();
    } else {
      document.getElementById('loginModal').classList.remove('hidden');
    }

    async function initApp() {
      await loadAllData();
      render();
      pollInterval = setInterval(loadAllData, 5000);  // Poll every 5s for real-time updates
      setupEventListeners();
    }

    function setupEventListeners() {
      document.getElementById('viewSelect').addEventListener('change', switchView);
      // Drag & drop on columns
      document.querySelectorAll('.column').forEach(col => {
        col.addEventListener('dragover', allowDrop);
        col.addEventListener('drop', handleDrop);
      });
    }

    async function loadAllData() {
      try {
        const tasksRes = await fetch(\`\${API_BASE}/api/tasks\`, { headers: authHeaders() });
        tasks = await tasksRes.json();
        const subsRes = await fetch(\`\${API_BASE}/api/subagents\`, { headers: authHeaders() });
        subagents = await subsRes.json();
        render();
      } catch (e) {
        console.error('Load failed:', e);
      }
    }

    function authHeaders() {
      return {
        'Authorization': \`Bearer \${apiKey}\`,
        'Content-Type': 'application/json'
      };
    }

    function render() {
      renderKanban();
      renderDashboard();
    }

    function renderKanban() {
      const statusMap = { 'todo': 'todo', 'inprogress': 'inprogress', 'done': 'done' };
      Object.entries(statusMap).forEach(([status, colStatus]) => {
        const col = document.querySelector(\`[data-status="\${colStatus}"] .cards\`);
        col.innerHTML = '';
        tasks
          .filter(task => task.status === status)
          .sort((a, b) => priorityOrder(b.priority) - priorityOrder(a.priority))
          .forEach(task => col.appendChild(createTaskCard(task)));
      });
    }

    function priorityOrder(p) {
      const order = { high: 3, medium: 2, low: 1 };
      return order[p] || 0;
    }

    function createTaskCard(task) {
      const card = document.createElement('div');
      card.className = 'group bg-gray-800/70 hover:bg-gray-700 border border-gray-600 rounded-2xl p-6 shadow-xl hover:shadow-2xl hover:shadow-cyan-500/25 cursor-grab active:cursor-grabbing transition-all duration-300 draggable min-h-[120px] flex flex-col';
      card.draggable = true;
      card.dataset.taskId = task.id;
      card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', task.id));

      const subagent = subagents.find(s => s.taskId === task.id);
      const statusBadge = subagent ? getStatusBadge(subagent.status) : '';

      card.innerHTML = \`
        <div class="flex justify-between items-start mb-3">
          <h4 class="font-semibold text-lg leading-tight line-clamp-2 mb-3"\${task.title}</h4>
          \${getPriorityBadge(task.priority)}
        </div>
        <p class="text-[var(--text-secondary)] text-sm leading-relaxed flex-1 line-clamp-3 mb-4"\${task.desc || ''}</p>
        \${statusBadge}
        <div class="actions opacity-0 group-hover:opacity-100 transition-opacity flex gap-2 mt-auto pt-4 border-t border-gray-700">
          <button onclick="editTask('\${task.id}')" class="p-2 hover:bg-blue-600 rounded-xl transition-colors">✏️</button>
          <button onclick="viewTaskHistory('\${task.id}')" class="p-2 hover:bg-purple-600 rounded-xl transition-colors">📜</button>
          \${task.assigned ? \`<span class="text-xs bg-gray-600 px-2 py-1 rounded-full">\${task.assigned.slice(0,8)}...\lt;/span>\` : ''}
        </div>
      \`;
      return card;
    }

    function getPriorityBadge(priority) {
      const colors = {
        low: '🟢 bg-green-500/20 text-green-400 border-green-400/50',
        medium: '🟡 bg-yellow-500/20 text-yellow-400 border-yellow-400/50',
        high: '🔴 bg-red-500/20 text-red-400 border-red-400/50'
      };
      const c = colors[priority] || 'bg-gray-500/20 text-gray-400 border-gray-400/50';
      return \`<span class="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold border \${c}">\${priority.toUpperCase()}\lt;/span>\`;
    }

    function getStatusBadge(status) {
      const colors = {
        idle: 'bg-gray-500/20 text-gray-400 border-gray-500/50',
        running: 'bg-blue-500/20 text-blue-400 border-blue-500/50 animate-pulse',
        completed: 'bg-green-500/20 text-green-400 border-green-500/50',
        failed: 'bg-red-500/20 text-red-400 border-red-500/50'
      };
      const c = colors[status] || 'bg-gray-500/20 text-gray-400';
      return \`<span class="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold border font-mono \${c}">● \${status.toUpperCase()}\lt;/span>\`;
    }

    function renderDashboard() {
      const list = document.getElementById('subagentList');
      list.innerHTML = subagents
        .sort((a, b) => new Date(b.started || 0) - new Date(a.started || 0))
        .map(sub => {
          const task = tasks.find(t => t.id === sub.taskId);
          return \`
            <div class="bg-gray-800/50 border border-gray-600 rounded-2xl p-8 hover:bg-gray-700/50 transition-all shadow-xl hover:shadow-2xl hover:shadow-blue-500/20">
              <h4 class="text-xl font-bold mb-2 \${task ? '' : 'text-gray-500'}">\${task ? task.title.slice(0,50) + '...' : 'No Task'}\lt;/h4>
              <p class="text-sm text-gray-400 mb-4">ID: \${sub.id}</p>
              \${getStatusBadge(sub.status)}
              <div class="flex gap-2 mt-6">
                <button onclick="manageSubagent('\${sub.id}', 'kill')" class="flex-1 bg-red-600 hover:bg-red-500 py-2 px-4 rounded-xl font-bold transition-all">Kill</button>
                \${task ? \`<button onclick="editTask('\${task.id}')" class="flex-1 bg-blue-600 hover:bg-blue-500 py-2 px-4 rounded-xl font-bold transition-all">View Task</button>\` : ''}
              </div>
            </div>
          \`;
        }).join('') || '<p class="col-span-full text-center text-gray-500 py-20 text-xl">No active subagents.</p>';
    }

    function allowDrop(e) {
      e.preventDefault();
    }

    async function handleDrop(e) {
      e.preventDefault();
      const taskId = e.dataTransfer.getData('text/plain');
      const newStatus = e.currentTarget.dataset.status;
      const task = tasks.find(t => t.id === taskId);
      if (task && task.status !== newStatus) {
        task.status = newStatus;
        task.updated = Date.now();
        if (!task.history) task.history = [];
        task.history.push({ ts: Date.now(), event: 'moved', log: \`Moved to \${newStatus.replace(/([A-Z])/g, ' $1').trim()}\` });
        await updateTask(task);
        render();
      }
    }

    async function updateTask(task) {
      await fetch(\`\${API_BASE}/api/tasks/\${task.id}\`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(task)
      });
    }

    function switchView() {
      const view = document.getElementById('viewSelect').value;
      document.getElementById('kanbanView').classList.toggle('hidden', view !== 'kanban');
      document.getElementById('dashboardView').classList.toggle('hidden', view !== 'dashboard');
      render();
    }

    // Task Modal Functions
    function addNewTask() {
      currentTaskId = crypto.randomUUID();
      isEditing = false;
      document.getElementById('modalTitle').textContent = 'New Task';
      document.getElementById('taskTitleInput').value = '';
      document.getElementById('taskDescInput').value = '';
      document.getElementById('taskPrioritySelect').value = 'medium';
      document.getElementById('taskSubagentInput').value = '';
      document.getElementById('spawnButton').classList.add('hidden');
      document.querySelector('#taskModal button[onclick="deleteCurrentTask()"]').classList.add('hidden');
      document.getElementById('taskModal').showModal();
    }

    function editTask(taskId) {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      currentTaskId = taskId;
      isEditing = true;
      document.getElementById('modalTitle').textContent = 'Edit Task';
      document.getElementById('taskTitleInput').value = task.title || '';
      document.getElementById('taskDescInput').value = task.desc || '';
      document.getElementById('taskPrioritySelect').value = task.priority || 'medium';
      document.getElementById('taskSubagentInput').value = task.assigned || '';
      document.getElementById('spawnButton').classList.toggle('hidden', !!task.assigned);
      document.querySelector('#taskModal button[onclick="deleteCurrentTask()"]').classList.remove('hidden');
      document.getElementById('taskModal').showModal();
    }

    async function saveCurrentTask() {
      const task = {
        id: currentTaskId,
        title: document.getElementById('taskTitleInput').value.trim(),
        desc: document.getElementById('taskDescInput').value.trim(),
        priority: document.getElementById('taskPrioritySelect').value,
        assigned: document.getElementById('taskSubagentInput').value.trim() || null,
        status: 'todo',
        history: [],
        created: Date.now(),
        updated: Date.now()
      };
      if (isEditing) {
        const oldTask = tasks.find(t => t.id === currentTaskId);
        task.status = oldTask.status;
        task.history = oldTask.history || [];
        task.created = oldTask.created;
      }
      await fetch(\`\${API_BASE}/api/tasks\`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(task)
      });
      closeTaskModal();
      loadAllData();
    }

    async function deleteCurrentTask() {
      if (confirm('Delete this task?')) {
        await fetch(\`\${API_BASE}/api/tasks/\${currentTaskId}\`, {
          method: 'DELETE',
          headers: authHeaders()
        });
        closeTaskModal();
        loadAllData();
      }
    }

    async function spawnSubagentForCurrent() {
      try {
        const res = await fetch(\`\${API_BASE}/api/spawn\`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ taskId: currentTaskId })
        });
        if (res.ok) {
          const data = await res.json();
          document.getElementById('taskSubagentInput').value = data.subagentId;
          alert('Subagent spawned: ' + data.subagentId);
        } else {
          alert('Spawn failed: ' + await res.text());
        }
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function manageSubagent(subId, action) {
      if (confirm(\`Kill subagent \${subId}?\`)) {
        await fetch(\`\${API_BASE}/api/manage/\${subId}\`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ action })
        });
        loadAllData();
      }
    }

    function viewTaskHistory(taskId) {
      const task = tasks.find(t => t.id === taskId);
      if (!task || !task.history?.length) {
        alert('No history available.');
        return;
      }
      document.getElementById('historyTitle').textContent = \`History for: \${task.title}\`;
      const content = document.getElementById('historyContent');
      content.innerHTML = task.history
        .sort((a, b) => b.ts - a.ts)
        .map(h => \`
          <div class="bg-gray-800 p-4 rounded-xl border-l-4 border-blue-500">
            <div class="font-bold text-cyan-400"\${new Date(h.ts).toLocaleString()}\lt;/div>
            <div class="text-lg font-bold capitalize"\${h.event}</div>
            \${h.log ? \`<p class="text-gray-300 mt-1"\${h.log}</p>\` : ''}
          </div>
        \`).join('');
      document.getElementById('historyModal').showModal();
    }

    function closeTaskModal() {
      document.getElementById('taskModal').close();
    }

    function closeHistoryModal() {
      document.getElementById('historyModal').close();
    }

    // Auth
    function login() {
      const key = document.getElementById('apiKeyInput').value.trim();
      if (!key) return alert('Enter API key');
      apiKey = key;
      localStorage.setItem('tarsApiKey', apiKey);
      document.getElementById('loginModal').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      initApp();
    }

    function logout() {
      localStorage.removeItem('tarsApiKey');
      apiKey = '';
      clearInterval(pollInterval);
      document.getElementById('app').classList.add('hidden');
      document.getElementById('loginModal').classList.remove('hidden');
      document.getElementById('loginModal').querySelector('input').value = '';
    }

    // Global drag setup (re-attach on render if needed)
    document.addEventListener('dragstart', (e) => {
      if (e.target.classList.contains('draggable')) {
        e.dataTransfer.effectAllowed = 'move';
      }
    });
  </script>
</body>
</html>`;
