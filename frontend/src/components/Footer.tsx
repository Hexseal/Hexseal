"use client";

import React from "react";
import Link from "next/link";
import { appChain, appChainId } from "@/config/chain";

export default function Footer() {
  return (
    <footer className="site-footer" role="contentinfo">
      <div className="footer-inner">
        <div className="footer-col">
          <h4>Signature404</h4>
          <p>Decentralized freelance protocol on Base. No admins. Code is law.</p>
        </div>
        <div className="footer-col">
          <h4>Resources</h4>
          <ul>
            <li><Link href="/docs/faq">FAQ</Link></li>
            <li>
              <a
                href="https://sepolia.basescan.org/address/0xF00CC71878c226E0b64253Fb71dD802aF12165D0"
                target="_blank"
                rel="noopener noreferrer"
              >
                Contract
              </a>
            </li>
            <li>
              <a
                href="https://github.com/Signature404/Signature404"
                target="_blank"
                rel="noopener noreferrer"
              >
                Source Code
              </a>
            </li>
          </ul>
        </div>
        <div className="footer-col">
          <h4>Connect</h4>
          <ul>
            <li>
              <a
                href="https://github.com/Signature404/Signature404"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
            </li>
            <li>
              <a
                href="https://github.com/Signature404/Signature404/issues"
                target="_blank"
                rel="noopener noreferrer"
              >
                Report Issue
              </a>
            </li>
          </ul>
        </div>
      </div>
      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} Signature404</span>
        <span>{appChain.name} · ChainId {appChainId}</span>
      </div>
    </footer>
  );
}
