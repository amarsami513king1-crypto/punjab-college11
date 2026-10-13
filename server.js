require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const path = require('path');
const pool = require('./db');

const app = express();
const isProd = process.env.NODE_ENV === 'production';
if (isProd) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  name: 'pnc.sid',
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.SESSION_COOKIE_SECURE === 'true',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
app.use('/api/public', publicLimiter);
app.use('/api/auth/login', authLimiter);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  maxAge: isProd ? '1h' : 0
}));

function requireAuth(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: 'Administrator login required.' });
  next();
}
function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const q = await pool.query(
        `SELECT 1 FROM role_permissions rp
         JOIN permissions p ON p.permission_code=rp.permission_code
         JOIN admin_accounts a ON a.role_id=rp.role_id
         WHERE a.admin_id=$1 AND p.permission_code=$2 AND a.account_status='Active'`,
        [req.session.admin.admin_id, permission]
      );
      if (!q.rowCount) return res.status(403).json({ error: 'You do not have permission to perform this action.' });
      next();
    } catch (e) { next(e); }
  };
}
async function audit(client, req, recordType, recordId, actionType, oldValues, newValues, reason) {
  await client.query(
    `INSERT INTO audit_log(admin_id,record_type,record_id,action_type,previous_values,new_values,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [req.session.admin.admin_id, recordType, String(recordId), actionType,
     oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null, reason || null]
  );
}

app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 200) {
      return res.status(400).json({ error: 'Enter a valid username and password.' });
    }
    const q = await pool.query(
      `SELECT a.admin_id,a.username,a.password_hash,a.role_id
       FROM admin_accounts a WHERE a.username=$1 AND a.account_status='Active'`,
      [username.trim()]
    );
    const valid = q.rowCount && await bcrypt.compare(password, q.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });
    req.session.regenerate(async (err) => {
      if (err) return next(err);
      req.session.admin = { admin_id: q.rows[0].admin_id, username: q.rows[0].username, role_id: q.rows[0].role_id };
      try {
        await pool.query('UPDATE admin_accounts SET last_login_at=now() WHERE admin_id=$1', [q.rows[0].admin_id]);
        res.json({ ok: true, username: q.rows[0].username });
      } catch (e) { next(e); }
    });
  } catch (e) { next(e); }
});
app.post('/api/auth/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('pnc.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.SESSION_COOKIE_SECURE === 'true' });
    res.json({ ok: true });
  });
});
app.get('/api/auth/me', (req, res) => res.json({ authenticated: !!req.session.admin, username: req.session.admin?.username || null }));

app.get('/api/public/examinations', async (req, res, next) => {
  try {
    const q = await pool.query(
      `SELECT e.examination_id, e.examination_name, ay.academic_year_name, e.class_id, c.class_name
       FROM examinations e JOIN academic_years ay USING(academic_year_id)
       LEFT JOIN classes c USING(class_id)
       WHERE e.publication_status='Published' AND (e.result_publication_date IS NULL OR e.result_publication_date <= now())
       ORDER BY ay.start_date DESC, e.examination_date DESC NULLS LAST, e.examination_name`
    );
    res.set('Cache-Control', 'no-store');
    res.json(q.rows);
  } catch (e) { next(e); }
});
app.get('/api/public/results/:rollNumber', async (req, res, next) => {
  try {
    const roll = String(req.params.rollNumber || '').trim();
    const examId = Number(req.query.examination_id);
    if (!/^[A-Za-z0-9\-\/]{1,40}$/.test(roll) || !Number.isInteger(examId) || examId < 1) {
      return res.status(400).json({ error: 'Enter a valid roll number and select an examination.' });
    }
    const result = await pool.query(
      `SELECT r.result_id,r.roll_number,r.total_marks,r.obtained_marks,r.percentage,r.result_status,r.remarks,
              r.published_at, s.student_name,s.father_name,c.class_name,sec.section_name,
              e.examination_name,e.examination_date,ay.academic_year_name
       FROM student_results r
       JOIN students s USING(student_id)
       JOIN classes c USING(class_id)
       LEFT JOIN sections sec ON sec.section_id=s.section_id
       JOIN examinations e USING(examination_id)
       JOIN academic_years ay ON ay.academic_year_id=e.academic_year_id
       WHERE r.roll_number=$1 AND r.examination_id=$2
         AND r.publication_status='Published'
         AND e.publication_status='Published'
         AND (e.result_publication_date IS NULL OR e.result_publication_date <= now())
       LIMIT 1`,
      [roll, examId]
    );
    res.set('Cache-Control', 'no-store, max-age=0');
    if (!result.rowCount) return res.status(404).json({ error: 'Result not found, not published, or not yet available.' });
    const r = result.rows[0];
    const marks = await pool.query(
      `SELECT sub.subject_name, es.subject_order, m.maximum_marks_snapshot AS maximum_marks,
              m.obtained_marks, m.subject_status, m.remarks
       FROM student_subject_marks m
       JOIN examination_subjects es USING(examination_subject_id)
       JOIN subjects sub USING(subject_id)
       WHERE m.result_id=$1
       ORDER BY es.subject_order, sub.subject_name`,
      [r.result_id]
    );
    res.json({
      student: { name: r.student_name, father_name: r.father_name, roll_number: r.roll_number,
        class_name: r.class_name, section_name: r.section_name },
      examination: { name: r.examination_name, academic_year: r.academic_year_name,
        examination_date: r.examination_date, published_at: r.published_at },
      marks: marks.rows,
      summary: { total_marks: r.total_marks, obtained_marks: r.obtained_marks,
        percentage: r.percentage, status: r.result_status, remarks: r.remarks }
    });
  } catch (e) { next(e); }
});

app.get('/api/admin/overview', requireAuth, requirePermission('students.read'), async (req, res, next) => {
  try {
    const [students, exams, results] = await Promise.all([
      pool.query('SELECT count(*)::int AS count FROM students'),
      pool.query('SELECT count(*)::int AS count FROM examinations'),
      pool.query("SELECT count(*)::int AS count FROM student_results WHERE publication_status='Published'")
    ]);
    res.json({ students: students.rows[0].count, examinations: exams.rows[0].count, published_results: results.rows[0].count });
  } catch (e) { next(e); }
});

app.get('/api/admin/classes', requireAuth, requirePermission('students.read'), async (req, res, next) => {
  try {
    const q = await pool.query('SELECT class_id,class_name FROM classes WHERE active_status=true ORDER BY class_name');
    res.json(q.rows);
  } catch (e) { next(e); }
});
app.get('/api/admin/years', requireAuth, requirePermission('students.read'), async (req, res, next) => {
  try {
    const q = await pool.query('SELECT academic_year_id,academic_year_name FROM academic_years ORDER BY start_date DESC');
    res.json(q.rows);
  } catch (e) { next(e); }
});
app.get('/api/admin/examinations', requireAuth, requirePermission('results.read'), async (req, res, next) => {
  try {
    const q = await pool.query(
      `SELECT e.examination_id,e.examination_name,e.publication_status,ay.academic_year_name,c.class_name
       FROM examinations e JOIN academic_years ay USING(academic_year_id)
       LEFT JOIN classes c USING(class_id) ORDER BY e.examination_id DESC`
    );
    res.json(q.rows);
  } catch (e) { next(e); }
});
app.post('/api/admin/students', requireAuth, requirePermission('students.write'), async (req, res, next) => {
  const { admission_number, student_name, father_name, class_id, section_id, academic_year_id } = req.body || {};
  if (!student_name?.trim() || !father_name?.trim() || !Number.isInteger(Number(class_id)) || !Number.isInteger(Number(academic_year_id))) {
    return res.status(400).json({ error: 'Student name, father name, class and academic year are required.' });
  }
  try {
    const q = await pool.query(
      `INSERT INTO students(admission_number,student_name,father_name,class_id,section_id,academic_year_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING student_id`,
      [admission_number?.trim() || null, student_name.trim(), father_name.trim(), Number(class_id),
       section_id ? Number(section_id) : null, Number(academic_year_id)]
    );
    res.status(201).json({ ok: true, student_id: q.rows[0].student_id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That admission number already exists.' });
    next(e);
  }
});

app.post('/api/admin/examinations', requireAuth, requirePermission('exams.manage'), async (req, res, next) => {
  const { examination_name, academic_year_id, class_id, examination_type, examination_date } = req.body || {};
  if (!examination_name?.trim() || !Number.isInteger(Number(academic_year_id)) || !examination_type?.trim()) {
    return res.status(400).json({ error: 'Examination name, academic year and type are required.' });
  }
  try {
    const q = await pool.query(
      `INSERT INTO examinations(examination_name,academic_year_id,class_id,examination_type,examination_date)
       VALUES($1,$2,$3,$4,$5) RETURNING examination_id`,
      [examination_name.trim(), Number(academic_year_id), class_id ? Number(class_id) : null,
       examination_type.trim(), examination_date || null]
    );
    res.status(201).json({ ok: true, examination_id: q.rows[0].examination_id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'This examination already exists for the selected year/class.' });
    next(e);
  }
});

app.post('/api/admin/examinations/:id/subjects', requireAuth, requirePermission('exams.manage'), async (req, res, next) => {
  const examId = Number(req.params.id);
  const { subject_id, maximum_marks, passing_marks, subject_order } = req.body || {};
  if (!Number.isInteger(examId) || !Number.isInteger(Number(subject_id)) ||
      !Number.isFinite(Number(maximum_marks)) || Number(maximum_marks) <= 0 ||
      (passing_marks !== undefined && passing_marks !== '' &&
       (!Number.isFinite(Number(passing_marks)) || Number(passing_marks) < 0 || Number(passing_marks) > Number(maximum_marks)))) {
    return res.status(400).json({ error: 'Valid subject and maximum/passing marks are required.' });
  }
  try {
    const q = await pool.query(
      `INSERT INTO examination_subjects(examination_id,subject_id,maximum_marks,passing_marks,subject_order)
       VALUES($1,$2,$3,$4,$5) RETURNING examination_subject_id`,
      [examId, Number(subject_id), Number(maximum_marks), passing_marks === '' || passing_marks == null ? null : Number(passing_marks), Number(subject_order || 0)]
    );
    res.status(201).json({ ok: true, examination_subject_id: q.rows[0].examination_subject_id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'This subject is already configured for the examination.' });
    next(e);
  }
});


app.get('/api/admin/examinations/:id/subjects', requireAuth, requirePermission('exams.manage'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid examination ID.' });
  try {
    const q = await pool.query(
      `SELECT es.examination_subject_id,es.maximum_marks,es.passing_marks,es.subject_order,sub.subject_name
       FROM examination_subjects es JOIN subjects sub USING(subject_id)
       WHERE es.examination_id=$1 AND es.active_status=true
       ORDER BY es.subject_order,sub.subject_name`, [id]
    );
    res.json(q.rows);
  } catch (e) { next(e); }
});

app.get('/api/admin/subjects', requireAuth, requirePermission('exams.manage'), async (req, res, next) => {
  try {
    const q = await pool.query('SELECT subject_id,subject_code,subject_name FROM subjects WHERE active_status=true ORDER BY subject_name');
    res.json(q.rows);
  } catch (e) { next(e); }
});

app.post('/api/admin/results', requireAuth, requirePermission('results.write'), async (req, res, next) => {
  const { student_id, examination_id, roll_number, marks, remarks } = req.body || {};
  if (!Number.isInteger(Number(student_id)) || !Number.isInteger(Number(examination_id)) ||
      !/^[A-Za-z0-9\-\/]{1,40}$/.test(String(roll_number || '').trim()) || !Array.isArray(marks) || !marks.length) {
    return res.status(400).json({ error: 'Student, examination, roll number and subject marks are required.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exam = await client.query(
      `SELECT es.examination_subject_id,es.maximum_marks,es.passing_marks,es.subject_order,sub.subject_name
       FROM examination_subjects es JOIN subjects sub USING(subject_id)
       WHERE es.examination_id=$1 AND es.active_status=true`,
      [Number(examination_id)]
    );
    if (!exam.rowCount) throw Object.assign(new Error('No subjects are configured for this examination.'), { status: 400 });
    const byId = new Map(exam.rows.map(s => [Number(s.examination_subject_id), s]));
    const incoming = new Map();
    for (const item of marks) {
      const id = Number(item.examination_subject_id);
      const config = byId.get(id);
      const value = Number(item.obtained_marks);
      if (!config || !Number.isFinite(value) || value < 0 || value > Number(config.maximum_marks)) {
        throw Object.assign(new Error('A subject mark is invalid or exceeds its maximum marks.'), { status: 400 });
      }
      if (incoming.has(id)) throw Object.assign(new Error('Duplicate subject marks were supplied.'), { status: 400 });
      incoming.set(id, value);
    }
    if (incoming.size !== exam.rowCount) throw Object.assign(new Error('Enter marks for every active subject before saving.'), { status: 400 });
    const student = await client.query(
      `SELECT student_id,class_id,academic_year_id FROM students WHERE student_id=$1`,
      [Number(student_id)]
    );
    if (!student.rowCount) throw Object.assign(new Error('Student not found.'), { status: 404 });
    const examMeta = await client.query('SELECT academic_year_id,class_id FROM examinations WHERE examination_id=$1', [Number(examination_id)]);
    if (!examMeta.rowCount) throw Object.assign(new Error('Examination not found.'), { status: 404 });
    if (Number(student.rows[0].academic_year_id) !== Number(examMeta.rows[0].academic_year_id) ||
        (examMeta.rows[0].class_id && Number(student.rows[0].class_id) !== Number(examMeta.rows[0].class_id))) {
      throw Object.assign(new Error('Student academic year/class does not match this examination.'), { status: 400 });
    }
    const total = exam.rows.reduce((sum, s) => sum + Number(s.maximum_marks), 0);
    const obtained = exam.rows.reduce((sum, s) => sum + incoming.get(Number(s.examination_subject_id)), 0);
    const percentage = total > 0 ? Math.round((obtained / total) * 10000) / 100 : 0;
    const passingModeQ = await client.query("SELECT setting_value FROM system_settings WHERE setting_key='passing_mode'");
    const passingMode = passingModeQ.rows[0]?.setting_value || 'all_subjects';
    let passed = true;
    if (passingMode === 'all_subjects') {
      passed = exam.rows.every(s => s.passing_marks == null || incoming.get(Number(s.examination_subject_id)) >= Number(s.passing_marks));
    } else {
      passed = percentage >= 33;
    }
    const result = await client.query(
      `INSERT INTO student_results(student_id,examination_id,roll_number,total_marks,obtained_marks,percentage,result_status,remarks)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(student_id,examination_id) DO UPDATE SET
         roll_number=EXCLUDED.roll_number,total_marks=EXCLUDED.total_marks,obtained_marks=EXCLUDED.obtained_marks,
         percentage=EXCLUDED.percentage,result_status=EXCLUDED.result_status,remarks=EXCLUDED.remarks,
         publication_status='Draft',published_at=NULL,published_by=NULL,updated_at=now()
       RETURNING result_id`,
      [Number(student_id), Number(examination_id), String(roll_number).trim(), total, obtained, percentage, passed ? 'Pass' : 'Fail', remarks?.trim() || null]
    );
    const resultId = result.rows[0].result_id;
    await client.query('DELETE FROM student_subject_marks WHERE result_id=$1', [resultId]);
    for (const s of exam.rows) {
      await client.query(
        `INSERT INTO student_subject_marks(result_id,examination_subject_id,maximum_marks_snapshot,obtained_marks)
         VALUES($1,$2,$3,$4)`,
        [resultId, s.examination_subject_id, s.maximum_marks, incoming.get(Number(s.examination_subject_id))]
      );
    }
    await audit(client, req, 'student_result', resultId, 'SAVE_DRAFT', null,
      { student_id: Number(student_id), examination_id: Number(examination_id), roll_number: String(roll_number).trim(), total, obtained, percentage, result_status: passed ? 'Pass' : 'Fail' },
      'Draft saved or updated; publication must be separately authorized.');
    await client.query('COMMIT');
    res.status(201).json({ ok: true, result_id: resultId, total_marks: total, obtained_marks: obtained, percentage, result_status: passed ? 'Pass' : 'Fail', publication_status: 'Draft' });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'That roll number is already used in this examination.' });
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  } finally { client.release(); }
});

app.post('/api/admin/results/:id/publish', requireAuth, requirePermission('results.publish'), async (req, res, next) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query(
      `SELECT r.*,e.publication_status AS exam_status,
       (SELECT count(*) FROM student_subject_marks m WHERE m.result_id=r.result_id) AS mark_count,
       (SELECT count(*) FROM examination_subjects es WHERE es.examination_id=r.examination_id AND es.active_status=true) AS subject_count
       FROM student_results r JOIN examinations e USING(examination_id)
       WHERE r.result_id=$1 FOR UPDATE OF r`, [id]
    );
    if (!q.rowCount) throw Object.assign(new Error('Result not found.'), { status: 404 });
    const r = q.rows[0];
    if (Number(r.mark_count) === 0 || Number(r.mark_count) !== Number(r.subject_count) || Number(r.total_marks) <= 0) {
      throw Object.assign(new Error('Cannot publish: subject marks are incomplete or invalid.'), { status: 400 });
    }
    const invalid = await client.query(
      `SELECT 1 FROM student_subject_marks m WHERE m.result_id=$1
       AND (m.obtained_marks < 0 OR m.obtained_marks > m.maximum_marks_snapshot) LIMIT 1`, [id]
    );
    if (invalid.rowCount) throw Object.assign(new Error('Cannot publish invalid marks.'), { status: 400 });
    const old = { publication_status: r.publication_status, published_at: r.published_at };
    await client.query(
      `UPDATE student_results SET publication_status='Published',published_at=now(),published_by=$2,updated_at=now()
       WHERE result_id=$1`, [id, req.session.admin.admin_id]
    );
    await audit(client, req, 'student_result', id, 'PUBLISH', old, { publication_status: 'Published' }, req.body?.reason);
    await client.query('COMMIT');
    res.json({ ok: true, publication_status: 'Published' });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  } finally { client.release(); }
});

app.post('/api/admin/results/:id/withdraw', requireAuth, requirePermission('results.publish'), async (req, res, next) => {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) return res.status(400).json({ error: 'Provide a reason of at least 5 characters.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query('SELECT publication_status FROM student_results WHERE result_id=$1 FOR UPDATE', [id]);
    if (!q.rowCount) throw Object.assign(new Error('Result not found.'), { status: 404 });
    await client.query("UPDATE student_results SET publication_status='Withdrawn',updated_at=now() WHERE result_id=$1", [id]);
    await audit(client, req, 'student_result', id, 'WITHDRAW', q.rows[0], { publication_status: 'Withdrawn' }, reason);
    await client.query('COMMIT');
    res.json({ ok: true, publication_status: 'Withdrawn' });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  } finally { client.release(); }
});

app.get('/api/admin/audit', requireAuth, requirePermission('audit.read'), async (req, res, next) => {
  try {
    const q = await pool.query(
      `SELECT a.audit_id,a.record_type,a.record_id,a.action_type,a.previous_values,a.new_values,a.occurred_at,a.reason,ad.username
       FROM audit_log a LEFT JOIN admin_accounts ad USING(admin_id)
       ORDER BY a.occurred_at DESC LIMIT 200`
    );
    res.json(q.rows);
  } catch (e) { next(e); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
app.use((err, req, res, next) => {
  console.error('Request failed:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`PNC result portal listening on port ${port}`));
