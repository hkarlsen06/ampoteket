-- Workshop volunteers for autumn 2026, published with their agreement. Staff
-- maintain the list afterwards in /admin/help; a name already listed is skipped.
INSERT INTO app.help_contacts(display_name,responsibility,discord,display_order,is_published)
SELECT v.display_name,v.responsibility,v.discord,v.display_order,true
FROM (VALUES
  ('Alexander Rocha Rosenkilde','Verkstedsjef','zol.tez',10),
  ('Alfred Schau','Lodding','alfred04',20),
  ('Hjalmar Karlsen','Lodding','hkarlsen_06',30),
  ('Ken Masuda Gylseth','Komponent/Lager','fracture10',40),
  ('Egle Brazyte','Komponent/Lager','.pizzaloverr',50),
  ('Aleksander Damlien Eide','PCB-fres ansvarlig','damlien',60),
  ('Kristine Thorsen Kleven','SoMe-ansvarlig','sheroredd',70),
  ('Magnus Støren Weden','Måleinstrumenter','fragletrollet',80),
  ('Arin Salar Ahmed','Måleinstrumenter','antixvi',90),
  ('Kristoffer Myrseth','3d-print ansvarlig','kirstof',100),
  ('Andreas John Sperber Olguin','3d-print ansvarlig','aj547275630a',110),
  ('Dina Mølmann Hansen','3d-print ansvarlig','spoekelse',120)
) AS v(display_name,responsibility,discord,display_order)
WHERE NOT EXISTS (SELECT FROM app.help_contacts c WHERE lower(c.display_name)=lower(v.display_name));
