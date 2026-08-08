import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * ⚠️ ЗАЧЕМ ЗДЕСЬ ЗАГОЛОВОК КЭША СТРАНИЦ.
 *
 * Next сам ставит предрисованным страницам `Cache-Control: s-maxage=31536000`
 * («кэшировать год»). Замерено на этом репозитории, `next start`:
 *
 *     GET /board → Cache-Control: s-maxage=31536000
 *     GET /chat  → Cache-Control: s-maxage=31536000
 *
 * В самом репозитории такой строки НЕТ НИГДЕ — её ставит Next. Cloudflare сейчас
 * её не слушает (`cf-cache-status: DYNAMIC`), и только поэтому мы живы. Но это
 * случайность настройки, а не устройство: начнёт слушать — и все получат
 * годовалую страницу со ссылками на куски кода, которых давно нет. Приложение
 * перестанет открываться совсем, и починить это будет нечем, потому что новый код
 * до человека не доедет.
 *
 * ⚠️ ПОЧЕМУ НЕ В `next.config.ts`. Пробовал и ЗАМЕРИЛ: правило `headers()` со
 * своим `Cache-Control` Next для предрисованных страниц НЕ ПРИМЕНЯЕТ —
 * `s-maxage=31536000` остаётся на месте (проверено подстановкой правила в
 * собранный `routes-manifest.json` и запросом). Единственное место, где заголовок
 * действительно перебивается, — этот посредник.
 *
 * Разметка страниц (HTML) обязана перепроверяться, куски кода с хешем в имени —
 * нет: они неизменяемы по построению и их кэш нам на пользу. Поэтому правило
 * применяется только к переходам, а `/_next/static` исключён в `matcher`.
 */
const PAGE_CACHE = 'public, max-age=0, must-revalidate';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip flash: if the user was previously connected (cookie set by wagmi client),
  // redirect them straight to /board before the home page ever renders.
  if (pathname === '/') {
    if (request.cookies.get('has-wallet')?.value === '1') {
      return NextResponse.redirect(new URL('/board', request.url));
    }
  }

  const res = NextResponse.next();
  // `set`, а не `append`: заменить чужое значение, а не добавить второе рядом —
  // два `Cache-Control` в одном ответе разбирают по-разному.
  res.headers.set('Cache-Control', PAGE_CACHE);
  // Cloudflare слушает `CDN-Cache-Control` независимо от правил в панели, и это
  // ровно тот рычаг, которого у нас не было: он говорит краю, что страницу
  // хранить нельзя, даже если в панели включат «кэшировать всё».
  res.headers.set('CDN-Cache-Control', PAGE_CACHE);
  return res;
}

export const config = {
  /**
   * Все переходы, КРОМЕ неизменяемых кусков и того, что кэшировать и так нельзя.
   *
   * ⚠️ Было три пути (`/`, `/dashboard/*`, `/admin/*`) — только ради перехода с
   * главной. Расширено намеренно: заголовок обязан стоять на КАЖДОЙ странице,
   * иначе перекрыт был бы ровно тот случай, который уже работает, а остальные
   * (доска, чат, сделка) остались бы с годовалым кэшем.
   *
   * `api` исключён: у обработчиков свои заголовки, и `/api/version` обязан
   * остаться `no-store` (иначе проверка версии вернёт тот же старый номер).
   */
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|icon|manifest.json|sw.js).*)'],
};
