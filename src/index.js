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

    return new Response('Not Found', { status: 404 });
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

const HTML = `&lt;!DOCTYPE html&gt;
&lt;html lang="en" class="dark"&gt;
&lt;head&gt;
  &lt;meta charset="UTF-8"&gt;
  &lt;meta name="viewport" content="width=device-width, initial-scale=1.0"&gt;
  &lt;title&gt;TARS Kanban Board&lt;/title&gt;
  &lt;script src="https://cdn.tailwindcss.com"&gt;&lt;/script&gt;
  &lt;link rel="preconnect" href="https://fonts.googleapis.com"&gt;
  &lt;link rel="preconnect" href="https://fonts.gstatic.com" crossorigin&gt;
  &lt;link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&amp;display=swap" rel="stylesheet"&gt;
  &lt;script&gt;
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            'orbitron': ['Orbitron', 'monospace'],
          },
        }
      }
    }
  &lt;/script&gt;
&lt;/head&gt;
&lt;body class="bg-gradient-to-br from-gray-900 via-black to-gray-900 text-white min-h-screen p-6 font-orbitron overflow-x-auto"&gt;

  &lt;!-- Login Modal --&gt;
  &lt;div id="loginModal" class="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 hidden"&gt;
    &lt;div class="bg-gray-800/90 backdrop-blur-md p-12 rounded-2xl border border-cyan-500/30 shadow-2xl shadow-cyan-500/20 max-w-sm w-full mx-4"&gt;
      &lt;h2 class="text-3xl font-bold text-cyan-400 mb-8 text-center"&gt;Enter API Key&lt;/h2&gt;
      &lt;input id="apiKeyInput" type="password" placeholder="Your secret API key..." class="w-full bg-gray-700/50 border border-gray-600 p-4 rounded-xl text-lg mb-6 focus:outline-none focus:ring-4 ring-cyan-500/30 transition-all"&gt;
      &lt;button onclick="login()" class="w-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-lg font-bold py-4 px-8 rounded-xl shadow-lg hover:shadow-xl transition-all duration-300"&gt;
        Access Kanban
      &lt;/button&gt;
    &lt;/div&gt;
  &lt;/div&gt;

  &lt;!-- Main App --&gt;
  &lt;div id="app" class="hidden max-w-7xl mx-auto"&gt;
    &lt;header class="flex flex-col sm:flex-row justify-between items-center mb-12 gap-4"&gt;
      &lt;h1 class="text-5xl md:text-6xl font-black bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-500 bg-clip-text text-transparent drop-shadow-2xl"&gt;
        TARS KANBAN
      &lt;/h1&gt;
      &lt;div class="flex items-center gap-4"&gt;
        &lt;select id="viewSelect" class="bg-gray-800 border border-gray-600 px-4 py-2 rounded-xl text-lg font-bold focus:ring-2 ring-cyan-500"&gt;
          &lt;option value="kanban"&gt;Kanban Board&lt;/option&gt;
          &lt;option value="dashboard"&gt;Subagents Dashboard&lt;/option&gt;
        &lt;/select&gt;
        &lt;button onclick="addNewTask()" class="bg-green-600 hover:bg-green-500 px-6 py-3 rounded-xl font-bold shadow-lg transition-all"&gt;+ New Task&lt;/button&gt;
        &lt;button onclick="logout()" class="bg-red-600 hover:bg-red-500 px-6 py-3 rounded-xl font-bold shadow-lg transition-all"&gt;Logout&lt;/button&gt;
      &lt;/div&gt;
    &lt;/header&gt;

    &lt;!-- Kanban View --&gt;
    &lt;div id="kanbanView" class="flex gap-6 pb-12"&gt;
      &lt;div class="column flex-1 min-w-[320px]" data-status="todo"&gt;
        &lt;h2 class="text-2xl font-bold bg-gradient-to-r from-orange-500 to-red-500 bg-clip-text text-transparent mb-6 text-center pb-2 border-b-4 border-orange-500/50"&gt;📋 To Do&lt;/h2&gt;
        &lt;div class="cards min-h-[400px] space-y-4"&gt;&lt;/div&gt;
      &lt;/div&gt;
      &lt;div class="column flex-1 min-w-[320px]" data-status="inprogress"&gt;
        &lt;h2 class="text-2xl font-bold bg-gradient-to-r from-yellow-400 to-amber-500 bg-clip-text text-transparent mb-6 text-center pb-2 border-b-4 border-yellow-400/50"&gt;⚙️ In Progress&lt;/h2&gt;
        &lt;div class="cards min-h-[400px] space-y-4"&gt;&lt;/div&gt;
      &lt;/div&gt;
      &lt;div class="column flex-1 min-w-[320px]" data-status="done"&gt;
        &lt;h2 class="text-2xl font-bold bg-gradient-to-r from-green-500 to-emerald-600 bg-clip-text text-transparent mb-6 text-center pb-2 border-b-4 border-green-500/50"&gt;✅ Done&lt;/h2&gt;
        &lt;div class="cards min-h-[400px] space-y-4"&gt;&lt;/div&gt;
      &lt;/div&gt;
    &lt;/div&gt;

    &lt;!-- Dashboard View --&gt;
    &lt;div id="dashboardView" class="hidden"&gt;
      &lt;h2 class="text-4xl font-bold mb-8 bg-gradient-to-r from-purple-400 to-pink-500 bg-clip-text text-transparent"&gt;🤖 Active Subagents&lt;/h2&gt;
      &lt;div id="subagentList" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"&gt;&lt;/div&gt;
    &lt;/div&gt;
  &lt;/div&gt;

  &lt;!-- Task Edit Modal --&gt;
  &lt;dialog id="taskModal" class="backdrop:bg-black/80 p-0 m-0 backdrop:backdrop-blur-md"&gt;
    &lt;div class="bg-gray-900/95 border border-gray-700 rounded-3xl p-8 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto shadow-2xl shadow-black/50"&gt;
      &lt;h3 id="modalTitle" class="text-3xl font-bold mb-6 text-cyan-400"&gt;New Task&lt;/h3&gt;
      &lt;input id="taskTitleInput" placeholder="Task Title" class="w-full bg-gray-800 border border-gray-600 p-4 rounded-xl mb-4 text-xl focus:ring-2 ring-cyan-500"&gt;
      &lt;textarea id="taskDescInput" placeholder="Description / Instructions for subagent" class="w-full bg-gray-800 border border-gray-600 p-4 rounded-xl mb-4 h-32 resize-vertical focus:ring-2 ring-cyan-500"&gt;&lt;/textarea&gt;
      &lt;div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6"&gt;
        &lt;select id="taskPrioritySelect" class="bg-gray-800 border border-gray-600 p-4 rounded-xl"&gt;
          &lt;option value="low"&gt;Low Priority 🟢&lt;/option&gt;
          &lt;option value="medium"&gt;Medium Priority 🟡&lt;/option&gt;
          &lt;option value="high"&gt;High Priority 🔴&lt;/option&gt;
        &lt;/select&gt;
        &lt;input id="taskSubagentInput" placeholder="Assigned Subagent ID (optional)" class="bg-gray-800 border border-gray-600 p-4 rounded-xl"&gt;
      &lt;/div&gt;
      &lt;div class="flex flex-wrap gap-3 justify-end"&gt;
        &lt;button id="spawnButton" onclick="spawnSubagentForCurrent()" class="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 px-6 py-3 rounded-xl font-bold shadow-lg transition-all"&gt;🚀 Spawn Subagent&lt;/button&gt;
        &lt;button onclick="saveCurrentTask()" class="bg-green-600 hover:bg-green-500 px-6 py-3 rounded-xl font-bold shadow-lg transition-all"&gt;💾 Save&lt;/button&gt;
        &lt;button onclick="deleteCurrentTask()" class="bg-red-600 hover:bg-red-500 px-6 py-3 rounded-xl font-bold shadow-lg transition-all"&gt;🗑️ Delete&lt;/button&gt;
        &lt;button onclick="closeTaskModal()" class="bg-gray-600 hover:bg-gray-500 px-6 py-3 rounded-xl font-bold transition-all"&gt;❌ Cancel&lt;/button&gt;
      &lt;/div&gt;
    &lt;/div&gt;
  &lt;/dialog&gt;

  &lt;!-- History Modal --&gt;
  &lt;dialog id="historyModal" class="backdrop:bg-black/80 p-0 m-0 backdrop:backdrop-blur-md"&gt;
    &lt;div class="bg-gray-900/95 border border-gray-700 rounded-3xl p-8 max-w-4xl w-full mx-4 max-h-[90vh] overflow-y-auto shadow-2xl"&gt;
      &lt;h3 id="historyTitle" class="text-3xl font-bold mb-6 text-purple-400"&gt;Task History&lt;/h3&gt;
      &lt;div id="historyContent" class="space-y-3 mb-8 text-sm"&gt;&lt;/div&gt;
      &lt;button onclick="closeHistoryModal()" class="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 py-4 px-8 rounded-xl font-bold text-lg shadow-lg transition-all"&gt;Close&lt;/button&gt;
    &lt;/div&gt;
  &lt;/dialog&gt;

  &lt;script&gt;
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
      document.querySelectorAll('.column').forEach(col =&gt; {
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
      Object.entries(statusMap).forEach(([status, colStatus]) =&gt; {
        const col = document.querySelector(\`[data-status="\${colStatus}"] .cards\`);
        col.innerHTML = '';
        tasks
          .filter(task =&gt; task.status === status)
          .sort((a, b) =&gt; priorityOrder(b.priority) - priorityOrder(a.priority))
          .forEach(task =&gt; col.appendChild(createTaskCard(task)));
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
      card.addEventListener('dragstart', (e) =&gt; e.dataTransfer.setData('text/plain', task.id));

      const subagent = subagents.find(s =&gt; s.taskId === task.id);
      const statusBadge = subagent ? getStatusBadge(subagent.status) : '';

      card.innerHTML = \`
        &lt;div class="flex justify-between items-start mb-3"&gt;
          &lt;h4 class="font-bold text-xl line-clamp-2 mb-2"\${task.title}&lt;/h4&gt;
          \${getPriorityBadge(task.priority)}
        &lt;/div&gt;
        &lt;p class="text-gray-400 text-sm mb-4 flex-1 line-clamp-3"\${task.desc || ''}&lt;/p&gt;
        \${statusBadge}
        &lt;div class="actions opacity-0 group-hover:opacity-100 transition-opacity flex gap-2 mt-auto pt-4 border-t border-gray-700"&gt;
          &lt;button onclick="editTask('\${task.id}')" class="p-2 hover:bg-blue-600 rounded-xl transition-colors"&gt;✏️&lt;/button&gt;
          &lt;button onclick="viewTaskHistory('\${task.id}')" class="p-2 hover:bg-purple-600 rounded-xl transition-colors"&gt;📜&lt;/button&gt;
          \${task.assigned ? \`&lt;span class="text-xs bg-gray-600 px-2 py-1 rounded-full"&gt;\${task.assigned.slice(0,8)}...\lt;/span&gt;\` : ''}
        &lt;/div&gt;
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
      return \`&lt;span class="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold border \${c}"&gt;\${priority.toUpperCase()}\lt;/span&gt;\`;
    }

    function getStatusBadge(status) {
      const colors = {
        idle: 'bg-gray-500/20 text-gray-400 border-gray-500/50',
        running: 'bg-blue-500/20 text-blue-400 border-blue-500/50 animate-pulse',
        completed: 'bg-green-500/20 text-green-400 border-green-500/50',
        failed: 'bg-red-500/20 text-red-400 border-red-500/50'
      };
      const c = colors[status] || 'bg-gray-500/20 text-gray-400';
      return \`&lt;span class="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold border font-mono \${c}"&gt;● \${status.toUpperCase()}\lt;/span&gt;\`;
    }

    function renderDashboard() {
      const list = document.getElementById('subagentList');
      list.innerHTML = subagents
        .sort((a, b) =&gt; new Date(b.started || 0) - new Date(a.started || 0))
        .map(sub =&gt; {
          const task = tasks.find(t =&gt; t.id === sub.taskId);
          return \`
            &lt;div class="bg-gray-800/50 border border-gray-600 rounded-2xl p-8 hover:bg-gray-700/50 transition-all shadow-xl hover:shadow-2xl hover:shadow-blue-500/20"&gt;
              &lt;h4 class="text-xl font-bold mb-2 \${task ? '' : 'text-gray-500'}"&gt;\${task ? task.title.slice(0,50) + '...' : 'No Task'}\lt;/h4&gt;
              &lt;p class="text-sm text-gray-400 mb-4"&gt;ID: \${sub.id}&lt;/p&gt;
              \${getStatusBadge(sub.status)}
              &lt;div class="flex gap-2 mt-6"&gt;
                &lt;button onclick="manageSubagent('\${sub.id}', 'kill')" class="flex-1 bg-red-600 hover:bg-red-500 py-2 px-4 rounded-xl font-bold transition-all"&gt;Kill&lt;/button&gt;
                \${task ? \`&lt;button onclick="editTask('\${task.id}')" class="flex-1 bg-blue-600 hover:bg-blue-500 py-2 px-4 rounded-xl font-bold transition-all"&gt;View Task&lt;/button&gt;\` : ''}
              &lt;/div&gt;
            &lt;/div&gt;
          \`;
        }).join('') || '&lt;p class="col-span-full text-center text-gray-500 py-20 text-xl"&gt;No active subagents.&lt;/p&gt;';
    }

    function allowDrop(e) {
      e.preventDefault();
    }

    async function handleDrop(e) {
      e.preventDefault();
      const taskId = e.dataTransfer.getData('text/plain');
      const newStatus = e.currentTarget.dataset.status;
      const task = tasks.find(t =&gt; t.id === taskId);
      if (task &amp;&amp; task.status !== newStatus) {
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
      const task = tasks.find(t =&gt; t.id === taskId);
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
        const oldTask = tasks.find(t =&gt; t.id === currentTaskId);
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
      const task = tasks.find(t =&gt; t.id === taskId);
      if (!task || !task.history?.length) {
        alert('No history available.');
        return;
      }
      document.getElementById('historyTitle').textContent = \`History for: \${task.title}\`;
      const content = document.getElementById('historyContent');
      content.innerHTML = task.history
        .sort((a, b) =&gt; b.ts - a.ts)
        .map(h =&gt; \`
          &lt;div class="bg-gray-800 p-4 rounded-xl border-l-4 border-blue-500"&gt;
            &lt;div class="font-bold text-cyan-400"\${new Date(h.ts).toLocaleString()}\lt;/div&gt;
            &lt;div class="text-lg font-bold capitalize"\${h.event}&lt;/div&gt;
            \${h.log ? \`&lt;p class="text-gray-300 mt-1"\${h.log}&lt;/p&gt;\` : ''}
          &lt;/div&gt;
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
    document.addEventListener('dragstart', (e) =&gt; {
      if (e.target.classList.contains('draggable')) {
        e.dataTransfer.effectAllowed = 'move';
      }
    });
  &lt;/script&gt;
&lt;/body&gt;
&lt;/html&gt;`;
