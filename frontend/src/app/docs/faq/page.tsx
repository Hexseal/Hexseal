"use client";

import React, { useState } from "react";
import Link from "next/link";
import { ChevronDown, ArrowLeft, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  ACTIVATION_WINDOW_DAYS,
  AUTO_APPROVE_WINDOW_DAYS,
} from "@/config/constants";
import { CONTRACTS } from "@/config/contracts";

interface FAQItem {
  q: string;
  a: React.ReactNode;
}

function FAQAccordion({ item }: { item: FAQItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`rounded-[18px] border transition-colors ${
        open
          ? "border-white/[0.10] bg-[#0d0d0f]"
          : "border-white/[0.06] bg-[#0d0d0f]/60"
      }`}
      style={{ boxShadow: open ? "0 2px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)" : undefined }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className="text-sm font-medium text-white/80">{item.q}</span>
        <ChevronDown
          className={`w-4 h-4 text-white/25 flex-shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="px-5 pb-4 text-sm text-white/45 leading-relaxed border-t border-white/[0.05] pt-3">
          {item.a}
        </div>
      )}
    </div>
  );
}

export default function FAQPage() {
  const t = useTranslations();

  const sections: Array<{ title: string; items: FAQItem[] }> = [
    {
      title: t("faq.s_general"),
      items: [
        { q: t("faq.q_what_is"),      a: t("faq.a_what_is") },
        { q: t("faq.q_who_controls"), a: t("faq.a_who_controls") },
        { q: t("faq.q_is_free"),      a: t("faq.a_is_free") },
        { q: t("faq.q_wallets"),      a: t("faq.a_wallets") },
        { q: t("faq.q_network"),      a: t("faq.a_network") },
        { q: t("faq.q_get_usdc"),     a: t("faq.a_get_usdc") },
      ],
    },
    {
      title: t("faq.s_deals"),
      items: [
        // Сроки подставляются из констант, а не пишутся числом в переводах:
        // иначе следующая правка Agreement.sol снова молча разойдётся с FAQ
        // (docs/OPEN-ITEMS.md п. 12 — три из четырёх строк оттуда живут здесь).
        { q: t("faq.q_how_deal"),    a: t("faq.a_how_deal", { days: AUTO_APPROVE_WINDOW_DAYS }) },
        { q: t("faq.q_no_activate"), a: t("faq.a_no_activate", { days: ACTIVATION_WINDOW_DAYS }) },
        { q: t("faq.q_deadline"),    a: t("faq.a_deadline") },
        { q: t("faq.q_cancel"),      a: t("faq.a_cancel", { days: ACTIVATION_WINDOW_DAYS }) },
        { q: t("faq.q_autoapprove"), a: t("faq.a_autoapprove") },
      ],
    },
    {
      title: t("faq.s_gasless"),
      items: [
        { q: t("faq.q_gasless"),   a: t("faq.a_gasless") },
        { q: t("faq.q_safe_sign"), a: t("faq.a_safe_sign") },
        { q: t("faq.q_censored"),  a: t("faq.a_censored") },
      ],
    },
    {
      title: t("faq.s_disputes"),
      items: [
        { q: t("faq.q_raise_dispute"),   a: t("faq.a_raise_dispute") },
        { q: t("faq.q_arbiters"),        a: t("faq.a_arbiters") },
        // Вопрос заведён намеренно, а не «на всякий случай»: самозапись в
        // арбитры на цепи выключена (applyAsArbiter() ревертит DAONotActive,
        // isDaoActive() == false), состав на старте набирается вручную. Без
        // прямого ответа человек читает «арбитры — нейтральные третьи стороны»
        // и делает вывод, что вход открыт.
        { q: t("faq.q_become_arbiter"),  a: t("faq.a_become_arbiter") },
        { q: t("faq.q_claim"),           a: t("faq.a_claim") },
        { q: t("faq.q_outcomes"),        a: t("faq.a_outcomes") },
        { q: t("faq.q_arbiter_timeout"), a: t("faq.a_arbiter_timeout") },
      ],
    },
    {
      title: t("faq.s_jobs"),
      items: [
        { q: t("faq.q_job_post"), a: t("faq.a_job_post") },
        { q: t("faq.q_service"),  a: t("faq.a_service") },
        { q: t("faq.q_nft"),      a: t("faq.a_nft") },
      ],
    },
    {
      title: t("faq.s_privacy"),
      items: [
        { q: t("faq.q_chat"),       a: t("faq.a_chat") },
        { q: t("faq.q_files"),      a: t("faq.a_files") },
        { q: t("faq.q_funds_safe"), a: t("faq.a_funds_safe") },
        { q: t("faq.q_audited"),    a: t("faq.a_audited") },
      ],
    },
    {
      title: t("faq.s_tech"),
      items: [
        { q: t("faq.q_diamond"), a: t("faq.a_diamond") },
        {
          q: t("faq.q_source"),
          a: (
            <a
              href="https://github.com/Hexseal/Hexseal"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1"
            >
              github.com/Hexseal/Hexseal <ExternalLink className="w-3 h-3" />
            </a>
          ),
        },
        // Адрес берётся из того же места, что и весь остальной код (CONTRACTS.diamond
        // ← NEXT_PUBLIC_DIAMOND_ADDRESS), а НЕ вписывается в переводы руками.
        // Причина: вписанный руками адрес указывал на 0xF00CC718… — брошенное
        // развёртывание, которое до сих пор живо на цепи и отдаёт СТАРЫЕ заказы,
        // то есть выглядит настоящим. Человек, пришедший «проверить контракты»
        // перед сделкой, смотрел бы не туда. Проверено на цепи 7 августа 2026:
        // живой диамонд — 11 фасетов и рабочая доска; тот, что был в справке —
        // 10 фасетов и заказы из прошлой жизни.
        { q: t("faq.q_verify"), a: t("faq.a_verify", { address: CONTRACTS.diamond }) },
      ],
    },
  ];

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      {/* Back */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs text-white/30 hover:text-white/60 transition-colors mb-8"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        {t("faq.back")}
      </Link>

      {/* Header */}
      <div className="mb-10">
        <p className="text-xs text-primary/70 font-semibold uppercase tracking-widest mb-2">
          {t("faq.docs_label")}
        </p>
        <h1 className="text-3xl font-black font-syne mb-3">{t("faq.title")}</h1>
        <p className="text-white/35 text-sm leading-relaxed">{t("faq.subtitle")}</p>
      </div>

      {/* Sections */}
      <div className="space-y-10">
        {sections.map((section) => (
          <div key={section.title}>
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-white/25 mb-3">
              {section.title}
            </h2>
            <div className="space-y-2">
              {section.items.map((item) => (
                <FAQAccordion key={item.q} item={item} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="mt-12 pt-6 border-t border-white/[0.06] text-center">
        <p className="text-xs text-white/25">
          {t("faq.still_questions")}{" "}
          <a
            href="https://github.com/Hexseal/Hexseal/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/45 hover:text-white/70 transition-colors"
          >
            {t("faq.open_issue")}
          </a>
        </p>
      </div>
    </div>
  );
}
