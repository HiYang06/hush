-- Some models reject a request to turn thinking off (D-029); for them the thinking switch has no "off".
ALTER TABLE models ADD COLUMN thinking_can_disable INTEGER NOT NULL DEFAULT 1;
