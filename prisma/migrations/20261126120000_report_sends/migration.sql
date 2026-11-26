-- Reports sent automatically (nightly Telegram summary): one row per kind and day
CREATE TABLE "report_sends" (
    "kind" VARCHAR(30) NOT NULL,
    "day" DATE NOT NULL,
    "sent_at" TIMESTAMP(3),
    "error" VARCHAR(300),
    "tries" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "report_sends_pkey" PRIMARY KEY ("kind","day")
);
