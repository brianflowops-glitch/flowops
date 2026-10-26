CREATE INDEX IF NOT EXISTS "booking_phone_e164_idx" ON "booking" USING btree ((case
    when "phone" is null or regexp_replace(btrim("phone"), '\s*(ext\.?|x)\s*\d+$', '', 'i') ~* '[a-z]' then null
    when left(regexp_replace(btrim("phone"), '\s*(ext\.?|x)\s*\d+$', '', 'i'), 1) = '+' then '+' || regexp_replace(regexp_replace(btrim("phone"), '\s*(ext\.?|x)\s*\d+$', '', 'i'), '\D', '', 'g')
    when length(regexp_replace(regexp_replace(btrim("phone"), '\s*(ext\.?|x)\s*\d+$', '', 'i'), '\D', '', 'g')) = 10 then '+1' || regexp_replace(regexp_replace(btrim("phone"), '\s*(ext\.?|x)\s*\d+$', '', 'i'), '\D', '', 'g')
    when length(regexp_replace(regexp_replace(btrim("phone"), '\s*(ext\.?|x)\s*\d+$', '', 'i'), '\D', '', 'g')) = 11 and left(regexp_replace(regexp_replace(btrim("phone"), '\s*(ext\.?|x)\s*\d+$', '', 'i'), '\D', '', 'g'), 1) = '1' then '+' || regexp_replace(regexp_replace(btrim("phone"), '\s*(ext\.?|x)\s*\d+$', '', 'i'), '\D', '', 'g')
    else null end));