"use client";

import React from "react";
import Link from "next/link";
import { appChain, appChainId, explorerUrl } from "@/config/chain";
import { CONTRACTS } from "@/config/contracts";
import { useTranslations } from "next-intl";

export default function Footer() {
  const t = useTranslations();

  return (
    <footer className="site-footer" role="contentinfo">
      <div className="footer-inner">
        <div className="footer-col">
          <h4>Hexseal</h4>
          <p>{t("footer.tagline")}</p>
        </div>
        <div className="footer-col">
          <h4>{t("footer.resources_title")}</h4>
          <ul>
            <li><Link href="/docs/faq">{t("footer.faq")}</Link></li>
            {/* ⚠️ Подпись в первой колонке говорит «управление пока у одного
                ключа, план передачи опубликован» — вот он, план. Без этой
                ссылки строка обещает документ, которого человеку негде взять:
                ровно та неправда, вместо которой она и написана. Ведёт на
                GitHub, потому что `docs/DECENTRALIZATION.md` живёт в репозитории,
                а не страницей сайта. */}
            <li>
              <a
                href="https://github.com/Hexseal/Hexseal/blob/main/docs/DECENTRALIZATION.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("footer.decentralization")}
              </a>
            </li>
            <li>
              <a
                href={explorerUrl('address', CONTRACTS.diamond)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("footer.contract")}
              </a>
            </li>
            <li>
              <a
                href="https://github.com/Hexseal/Hexseal"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("footer.source_code")}
              </a>
            </li>
          </ul>
        </div>
        <div className="footer-col">
          <h4>{t("footer.connect_title")}</h4>
          <ul>
            <li>
              <a
                href="https://github.com/Hexseal/Hexseal"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("footer.github")}
              </a>
            </li>
            <li>
              <a
                href="https://github.com/Hexseal/Hexseal/issues"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("footer.report_issue")}
              </a>
            </li>
          </ul>
        </div>
      </div>
      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} Hexseal</span>
        <span>{appChain.name} · ChainId {appChainId}</span>
      </div>
    </footer>
  );
}
