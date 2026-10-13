BEGIN;

CREATE TABLE IF NOT EXISTS roles (
  role_id BIGSERIAL PRIMARY KEY,
  role_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  permission_code TEXT PRIMARY KEY,
  permission_description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id BIGINT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(permission_code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

INSERT INTO roles(role_name) VALUES ('Administrator'), ('Results Officer'), ('Read Only')
ON CONFLICT (role_name) DO NOTHING;

INSERT INTO permissions(permission_code, permission_description) VALUES
 ('students.read','View student records'),
 ('students.write','Create and update student records'),
 ('results.read','View examination results'),
 ('results.write','Create and edit draft results'),
 ('results.publish','Publish or unpublish results'),
 ('results.delete','Delete results where permitted'),
 ('exams.manage','Manage examinations and subjects'),
 ('admins.manage','Manage administrator accounts'),
 ('audit.read','Review audit history'),
 ('settings.manage','Manage system settings')
ON CONFLICT (permission_code) DO NOTHING;

-- Administrator role receives all permissions; lesser roles can be configured later.
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.role_id, p.permission_code
FROM roles r CROSS JOIN permissions p
WHERE r.role_name = 'Administrator'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS academic_years (
  academic_year_id BIGSERIAL PRIMARY KEY,
  academic_year_name TEXT NOT NULL UNIQUE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  active_status BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS classes (
  class_id BIGSERIAL PRIMARY KEY,
  class_name TEXT NOT NULL UNIQUE,
  class_code TEXT NOT NULL UNIQUE,
  description TEXT,
  active_status BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sections (
  section_id BIGSERIAL PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes(class_id),
  section_name TEXT NOT NULL,
  section_code TEXT NOT NULL,
  active_status BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(class_id, section_name),
  UNIQUE(class_id, section_code)
);

CREATE TABLE IF NOT EXISTS students (
  student_id BIGSERIAL PRIMARY KEY,
  admission_number TEXT UNIQUE,
  student_name TEXT NOT NULL,
  father_name TEXT NOT NULL,
  class_id BIGINT NOT NULL REFERENCES classes(class_id),
  section_id BIGINT REFERENCES sections(section_id),
  academic_year_id BIGINT NOT NULL REFERENCES academic_years(academic_year_id),
  enrollment_status TEXT NOT NULL DEFAULT 'Active'
    CHECK (enrollment_status IN ('Active','Inactive','Graduated','Withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS examinations (
  examination_id BIGSERIAL PRIMARY KEY,
  examination_name TEXT NOT NULL,
  academic_year_id BIGINT NOT NULL REFERENCES academic_years(academic_year_id),
  class_id BIGINT REFERENCES classes(class_id),
  examination_type TEXT NOT NULL,
  examination_date DATE,
  result_publication_date TIMESTAMPTZ,
  publication_status TEXT NOT NULL DEFAULT 'Draft'
    CHECK (publication_status IN ('Draft','Scheduled','Published','Withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(examination_name, academic_year_id, class_id)
);

CREATE TABLE IF NOT EXISTS subjects (
  subject_id BIGSERIAL PRIMARY KEY,
  subject_code TEXT NOT NULL UNIQUE,
  subject_name TEXT NOT NULL UNIQUE,
  subject_category TEXT,
  active_status BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO subjects(subject_code, subject_name, subject_category) VALUES
 ('ENG','English','Language'), ('URD','Urdu','Language'),
 ('BIO','Biology','Science'), ('MATH','Mathematics','Science'),
 ('PSY','Psychology','Elective'), ('CS','Computer Science','Science'),
 ('CHEM','Chemistry','Science'), ('STAT','Statistics','Science'),
 ('PHY','Physics','Science'), ('CIV','Civics','Social Science'),
 ('TQ','T.Q. (Tarjuma-tul-Quran)','Religious Studies'),
 ('ISL','Islamiat','Religious Studies')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS examination_subjects (
  examination_subject_id BIGSERIAL PRIMARY KEY,
  examination_id BIGINT NOT NULL REFERENCES examinations(examination_id) ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES subjects(subject_id),
  maximum_marks NUMERIC(8,2) NOT NULL CHECK (maximum_marks > 0),
  passing_marks NUMERIC(8,2) CHECK (passing_marks >= 0 AND passing_marks <= maximum_marks),
  subject_weight NUMERIC(8,4),
  subject_order INTEGER NOT NULL DEFAULT 0,
  active_status BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(examination_id, subject_id)
);

CREATE TABLE IF NOT EXISTS admin_accounts (
  admin_id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role_id BIGINT NOT NULL REFERENCES roles(role_id),
  account_status TEXT NOT NULL DEFAULT 'Active'
    CHECK (account_status IN ('Active','Disabled','Locked')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_results (
  result_id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(student_id),
  examination_id BIGINT NOT NULL REFERENCES examinations(examination_id),
  roll_number TEXT NOT NULL,
  total_marks NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total_marks >= 0),
  obtained_marks NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (obtained_marks >= 0),
  percentage NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (percentage >= 0 AND percentage <= 100),
  result_status TEXT NOT NULL DEFAULT 'Pending'
    CHECK (result_status IN ('Pass','Fail','Pending','Absent','Withheld')),
  remarks TEXT,
  publication_status TEXT NOT NULL DEFAULT 'Draft'
    CHECK (publication_status IN ('Draft','Published','Withdrawn')),
  published_at TIMESTAMPTZ,
  published_by BIGINT REFERENCES admin_accounts(admin_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(student_id, examination_id),
  UNIQUE(examination_id, roll_number)
);

CREATE INDEX IF NOT EXISTS idx_results_public_search
  ON student_results(examination_id, roll_number, publication_status);
CREATE INDEX IF NOT EXISTS idx_students_year_class
  ON students(academic_year_id, class_id);

CREATE TABLE IF NOT EXISTS student_subject_marks (
  student_subject_mark_id BIGSERIAL PRIMARY KEY,
  result_id BIGINT NOT NULL REFERENCES student_results(result_id) ON DELETE CASCADE,
  examination_subject_id BIGINT NOT NULL REFERENCES examination_subjects(examination_subject_id),
  maximum_marks_snapshot NUMERIC(8,2) NOT NULL CHECK (maximum_marks_snapshot > 0),
  obtained_marks NUMERIC(8,2) NOT NULL CHECK (obtained_marks >= 0),
  subject_status TEXT NOT NULL DEFAULT 'Present'
    CHECK (subject_status IN ('Present','Absent','Exempt','Withheld')),
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(result_id, examination_subject_id),
  CHECK (obtained_marks <= maximum_marks_snapshot)
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT REFERENCES admin_accounts(admin_id),
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  changed_fields JSONB,
  previous_values JSONB,
  new_values JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_log(record_type, record_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  setting_id BIGSERIAL PRIMARY KEY,
  setting_key TEXT NOT NULL UNIQUE,
  setting_value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES admin_accounts(admin_id)
);
INSERT INTO system_settings(setting_key, setting_value, description) VALUES
 ('college_name', '"Punjab National College — Peshawar Chapter"', 'Public college name'),
 ('percentage_decimals', '2', 'Decimal places used for percentages'),
 ('passing_mode', '"all_subjects"', 'Configured passing policy: all_subjects or aggregate')
ON CONFLICT (setting_key) DO NOTHING;

COMMIT;
