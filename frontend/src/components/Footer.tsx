"use client";

import React from "react";
import Link from "next/link";
import { appChain, appChainId } from "@/config/chain";
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
            <li>
              <a
                href="https://sepolia.basescan.org/address/0xF00CC71878c226E0b64253Fb71dD802aF12165D0"
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
