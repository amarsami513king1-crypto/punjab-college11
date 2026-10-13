const $ = (s) => document.querySelector(s);
const resultArea = $('#resultArea');
const examSelect = $('#examination');
let exams = [];
let configuredSubjects = [];

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
function message(el, text, kind = '') { el.textContent = text; el.className = `message ${kind}`.trim(); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmt(n) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function dateFmt(v) { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString(); }

async function loadPublicExams() {
  try {
    exams = await api('/api/public/examinations');
    examSelect.innerHTML = '<option value="">Select examination</option>' + exams.map(e =>
      `<option value="${e.examination_id}">${escapeHtml(e.academic_year_name)} — ${escapeHtml(e.examination_name)}${e.class_name ? ' — ' + escapeHtml(e.class_name) : ''}</option>`
    ).join('');
    if (!exams.length) examSelect.innerHTML = '<option value="">No published examinations available</option>';
  } catch (e) { examSelect.innerHTML = '<option value="">Could not load examinations</option>'; }
}
$('#searchForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  resultArea.hidden = true;
  message($('#searchMessage'), 'Searching…');
  const roll = $('#rollNumber').value.trim();
  const exam = examSelect.value;
  try {
    const data = await api(`/api/public/results/${encodeURIComponent(roll)}?examination_id=${encodeURIComponent(exam)}`);
    message($('#searchMessage'), 'Published result found.', 'success');
    renderResult(data);
  } catch (e) { message($('#searchMessage'), e.message, 'error'); }
});
function renderResult(d) {
  const s = d.student, e = d.examination, r = d.summary;
  const rows = d.marks.map((m, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(m.subject_name)}</td><td>${fmt(m.maximum_marks)}</td><td>${fmt(m.obtained_marks)}</td><td>${escapeHtml(m.subject_status)}</td></tr>`).join('');
  resultArea.innerHTML = `<article class="result-card">
    <div class="marksheet-head"><div class="brandmark" style="margin:0 auto 8px;color:#12335b;border-color:#12335b">PNC</div>
      <h2>Punjab National College</h2><p><strong>Peshawar Chapter</strong></p><p>Official Online Examination Marksheet</p>
      <p>Academic Year: ${escapeHtml(e.academic_year)}</p><p>Examination: ${escapeHtml(e.name)}</p>
    </div>
    <div class="student-grid">
      <div><strong>Student Name</strong>${escapeHtml(s.name)}</div><div><strong>Father Name</strong>${escapeHtml(s.father_name)}</div>
      <div><strong>Roll Number</strong>${escapeHtml(s.roll_number)}</div><div><strong>Class / Section</strong>${escapeHtml(s.class_name)} / ${escapeHtml(s.section_name || '—')}</div>
      <div><strong>Examination Date</strong>${dateFmt(e.examination_date)}</div><div><strong>Result Published</strong>${dateFmt(e.published_at)}</div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Subject</th><th>Maximum Marks</th><th>Obtained Marks</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="summary-grid">
      <div class="summary-cell"><span>Total Marks</span><strong>${fmt(r.total_marks)}</strong></div>
      <div class="summary-cell"><span>Obtained Marks</span><strong>${fmt(r.obtained_marks)}</strong></div>
      <div class="summary-cell"><span>Percentage</span><strong>${fmt(r.percentage)}%</strong></div>
    </div>
    <p><strong>Result Status:</strong> <span class="status ${r.status === 'Fail' ? 'fail' : ''}">${escapeHtml(r.status)}</span></p>
    ${r.remarks ? `<p><strong>Remarks:</strong> ${escapeHtml(r.remarks)}</p>` : ''}
    <p class="muted small">This marksheet reflects the result currently published by the college.</p>
    <div class="result-actions"><button class="button button-outline" onclick="window.print()">Print / Save as PDF</button></div>
  </article>`;
  resultArea.hidden = false;
}

const adminDialog = $('#adminDialog'), dashboardDialog = $('#dashboardDialog');
$('#adminOpen').addEventListener('click', async () => {
  const me = await api('/api/auth/me').catch(() => ({authenticated:false}));
  if (me.authenticated) { await openDashboard(me.username); }
  else adminDialog.showModal();
});
$('#adminClose').addEventListener('click', () => adminDialog.close());
$('#dashboardClose').addEventListener('click', () => dashboardDialog.close());
$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  message($('#loginMessage'), 'Signing in…');
  try {
    const data = await api('/api/auth/login', {method:'POST', body:JSON.stringify({username:$('#username').value, password:$('#password').value})});
    adminDialog.close();
    $('#password').value = '';
    await openDashboard(data.username);
  } catch(e) { message($('#loginMessage'), e.message, 'error'); }
});
async function openDashboard(username) {
  $('#adminWelcome').textContent = `Signed in as ${username}`;
  dashboardDialog.showModal();
  await Promise.all([loadOverview(), loadAdminLists()]);
}
async function loadOverview() {
  try {
    const d = await api('/api/admin/overview');
    $('#dashboardStats').innerHTML = [['Students',d.students],['Examinations',d.examinations],['Published results',d.published_results]]
      .map(([k,v]) => `<div class="stat"><strong>${v}</strong><span>${k}</span></div>`).join('');
  } catch(e) { message($('#adminMessage'), e.message, 'error'); }
}
function setOptions(el, items, valueKey, labelFn, placeholder) {
  el.innerHTML = (placeholder ? `<option value="">${placeholder}</option>` : '') +
    items.map(i => `<option value="${i[valueKey]}">${escapeHtml(labelFn(i))}</option>`).join('');
}
async function loadAdminLists() {
  try {
    const [classes, years, allExams, subjects] = await Promise.all([
      api('/api/admin/classes'), api('/api/admin/years'), api('/api/admin/examinations'), api('/api/admin/subjects')
    ]);
    setOptions($('#studentClass'), classes, 'class_id', x=>x.class_name, 'Select class');
    setOptions($('#examClass'), classes, 'class_id', x=>x.class_name, 'All / not specified');
    setOptions($('#studentYear'), years, 'academic_year_id', x=>x.academic_year_name, 'Select year');
    setOptions($('#examYear'), years, 'academic_year_id', x=>x.academic_year_name, 'Select year');
    setOptions($('#configExam'), allExams, 'examination_id', x=>`${x.academic_year_name} — ${x.examination_name} (${x.publication_status})`, 'Select examination');
    setOptions($('#resultExam'), allExams, 'examination_id', x=>`${x.academic_year_name} — ${x.examination_name}`, 'Select examination');
    setOptions($('#configSubject'), subjects, 'subject_id', x=>`${x.subject_name} (${x.subject_code})`, 'Select subject');
    exams = allExams;
    await loadConfiguredSubjects();
  } catch(e) { message($('#adminMessage'), e.message, 'error'); }
}
async function loadConfiguredSubjects() {
  const examId = $('#resultExam').value || $('#configExam').value;
  if (!examId) { $('#marksFields').innerHTML = '<p class="muted small">Select an examination after configuring its subjects.</p>'; return; }
  try {
    configuredSubjects = await api(`/api/admin/examinations/${examId}/subjects`);
    $('#marksFields').innerHTML = configuredSubjects.map(s =>
      `<label>${escapeHtml(s.subject_name)} (max ${fmt(s.maximum_marks)})<input type="number" min="0" max="${s.maximum_marks}" step="0.01" data-exam-subject="${s.examination_subject_id}" required></label>`
    ).join('') || '<p class="muted small">No subjects configured for this examination yet.</p>';
  } catch(e) { $('#marksFields').innerHTML = `<p class="message error">${escapeHtml(e.message)}</p>`; }
}
$('#resultExam').addEventListener('change', loadConfiguredSubjects);
$('#configExam').addEventListener('change', loadConfiguredSubjects);
$('#studentForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(ev.currentTarget));
  try { const d = await api('/api/admin/students',{method:'POST',body:JSON.stringify(f)}); message($('#adminMessage'),`Student saved. Student ID: ${d.student_id}. Use this ID when creating a result.`,'success'); ev.currentTarget.reset(); }
  catch(e) { message($('#adminMessage'),e.message,'error'); }
});
$('#examForm').addEventListener('submit', async (ev) => {
  ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.currentTarget));
  try { const d = await api('/api/admin/examinations',{method:'POST',body:JSON.stringify(f)}); message($('#adminMessage'),`Examination created. ID: ${d.examination_id}. Configure subjects next.`,'success'); await loadAdminLists(); }
  catch(e) { message($('#adminMessage'),e.message,'error'); }
});
$('#subjectConfigForm').addEventListener('submit', async (ev) => {
  ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.currentTarget)); const id=f.examination_id; delete f.examination_id;
  try { const d = await api(`/api/admin/examinations/${id}/subjects`,{method:'POST',body:JSON.stringify(f)}); message($('#adminMessage'),`Subject configured. Configuration ID: ${d.examination_subject_id}.`,'success'); await loadConfiguredSubjects(); }
  catch(e) { message($('#adminMessage'),e.message,'error'); }
});
$('#resultForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const f = Object.fromEntries(new FormData(form));
  const marks = [...$('#marksFields').querySelectorAll('[data-exam-subject]')].map(i=>({examination_subject_id:Number(i.dataset.examSubject),obtained_marks:Number(i.value)}));
  f.marks = marks;
  try {
    const d = await api('/api/admin/results',{method:'POST',body:JSON.stringify(f)});
    message($('#adminMessage'),`Draft saved. Result ID: ${d.result_id} · ${fmt(d.obtained_marks)}/${fmt(d.total_marks)} · ${fmt(d.percentage)}% · ${d.result_status}. Publish it when approved.`,'success');
    $('#publishForm [name="result_id"]').value = d.result_id;
    $('#withdrawForm [name="result_id"]').value = d.result_id;
  } catch(e) { message($('#adminMessage'),e.message,'error'); }
});
$('#publishForm').addEventListener('submit', async (ev) => {
  ev.preventDefault(); const id = new FormData(ev.currentTarget).get('result_id');
  try { await api(`/api/admin/results/${id}/publish`,{method:'POST',body:JSON.stringify({})}); message($('#adminMessage'),`Result ${id} published successfully and is now eligible for public search.`,'success'); }
  catch(e) { message($('#adminMessage'),e.message,'error'); }
});
$('#withdrawForm').addEventListener('submit', async (ev) => {
  ev.preventDefault(); const f=Object.fromEntries(new FormData(ev.currentTarget)); const id=f.result_id; delete f.result_id;
  try { await api(`/api/admin/results/${id}/withdraw`,{method:'POST',body:JSON.stringify(f)}); message($('#adminMessage'),`Result ${id} withdrawn from public search.`,'success'); }
  catch(e) { message($('#adminMessage'),e.message,'error'); }
});
$('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/auth/logout',{method:'POST',body:'{}'}); dashboardDialog.close(); message($('#searchMessage'),'You have signed out.'); }
  catch(e) { message($('#adminMessage'),e.message,'error'); }
});
loadPublicExams();
