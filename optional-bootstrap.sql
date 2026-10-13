-- OPTIONAL SETUP EXAMPLE. Review dates and names before executing.
INSERT INTO academic_years(academic_year_name,start_date,end_date,active_status)
VALUES ('2026-2027','2026-04-01','2027-03-31',true)
ON CONFLICT (academic_year_name) DO NOTHING;

INSERT INTO classes(class_name,class_code) VALUES
 ('Class 9','C9'),('Class 10','C10'),('First Year','FY'),('Second Year','SY')
ON CONFLICT DO NOTHING;

-- Then create an examination through the admin panel.
