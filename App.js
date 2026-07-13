import React, { useRef, useEffect, useCallback } from 'react';
import { SafeAreaView, StatusBar, StyleSheet, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import mobileAds, {
  RewardedAd,
  RewardedAdEventType,
  AdEventType,
  TestIds,
} from 'react-native-google-mobile-ads';
import { requestTrackingPermissionsAsync } from 'expo-tracking-transparency';
import html from './htmlSource';

/*
 * このアプリは Web 版（index.html）を WebView で表示するラッパーです。
 * ゲームのロジック・保存・UI はすべて index.html 側にあります。
 * このファイルの役割は「答え」を見る前の AdMob リワード動画の表示だけ:
 *   HTML が window.ReactNativeWebView.postMessage('SHOW_REWARDED_AD') を送る
 *     → 先読み済みならその場で AdMob のリワード広告を表示
 *     → まだ読み込めていなければ window.__onAdLoading() を注入して「準備中」を出し、
 *       LOAD_WAIT_MS まで読み込みを待つ
 *     → 視聴完了/閉じた/あきらめた時点で window.__onAdFinished(rewarded) を注入して返す
 */

// 開発中は必ず Google のテスト広告を使う（本番広告の誤クリックはアカウント停止リスク）。
// 本番ビルド(__DEV__=false)では、AdMob で作成した実際のリワード広告ユニットIDを使う。
const REWARDED_UNIT_ID = __DEV__
  ? TestIds.REWARDED
  : 'ca-app-pub-1081803676733486/3954974297';

// 「答え」を押した時点でまだ広告が読み込めていない場合に、あきらめるまで待つ時間。
const LOAD_WAIT_MS = 8000;
// 広告が取得できなかった理由を画面に出しておく時間（そのあと答えを通す）。
const ERROR_SHOW_MS = 2200;

export default function App() {
  const webRef = useRef(null);
  const adRef = useRef(null);
  const earnedRef = useRef(false);
  const loadedRef = useRef(false);
  const pendingRef = useRef(false); // 「答え」待ちで広告のロードを待っている最中か
  const waitTimerRef = useRef(null);

  const sendToWeb = useCallback((js) => {
    if (webRef.current) webRef.current.injectJavaScript(js + '; true;');
  }, []);

  // 待ち状態を解除して、視聴結果を Web に返す。
  const finish = useCallback(
    (rewarded) => {
      pendingRef.current = false;
      if (waitTimerRef.current) {
        clearTimeout(waitTimerRef.current);
        waitTimerRef.current = null;
      }
      sendToWeb(
        'window.__onAdFinished && window.__onAdFinished(' +
          (rewarded ? 'true' : 'false') +
          ')'
      );
    },
    [sendToWeb]
  );

  // リワード広告を1本ぶん用意して先読みする。閉じたら結果を Web に返し、次を先読み。
  const preloadAd = useCallback(() => {
    const ad = RewardedAd.createForAdRequest(REWARDED_UNIT_ID, {
      requestNonPersonalizedAdsOnly: false,
    });
    earnedRef.current = false;
    loadedRef.current = false;

    const unsub = [];
    const detach = () => {
      unsub.forEach((u) => u());
      unsub.length = 0;
    };

    unsub.push(
      ad.addAdEventListener(RewardedAdEventType.LOADED, () => {
        loadedRef.current = true;
        // 「答え」を押して待たせている最中に読み込めたら、そのまま再生する
        if (pendingRef.current) {
          pendingRef.current = false;
          if (waitTimerRef.current) {
            clearTimeout(waitTimerRef.current);
            waitTimerRef.current = null;
          }
          try {
            ad.show();
          } catch (e) {
            finish(true);
          }
        }
      })
    );
    unsub.push(
      ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
        earnedRef.current = true; // 最後まで視聴＝報酬獲得
      })
    );
    unsub.push(
      ad.addAdEventListener(AdEventType.CLOSED, () => {
        // 報酬を得ていれば true（＝答えを表示）、途中で閉じたら false（表示しない）
        finish(earnedRef.current);
        detach();
        preloadAd(); // 次回ぶんを先読み
      })
    );
    unsub.push(
      ad.addAdEventListener(AdEventType.ERROR, (error) => {
        // 広告が出せない時は答えをブロックしない（true で通す）。
        // ただし理由（no-fill＝在庫なし/審査待ち、設定ミス等）が分からないと切り分けできないので、
        // 「答え」を待たせている最中のエラーは、理由を画面に出してから答えを通す。
        const code = String(
          (error && (error.code || error.message)) || 'unknown'
        );
        if (pendingRef.current) {
          sendToWeb(
            'window.__onAdError && window.__onAdError(' +
              JSON.stringify(code) +
              ')'
          );
          setTimeout(() => finish(true), ERROR_SHOW_MS);
        }
        detach();
        setTimeout(preloadAd, 4000);
      })
    );

    adRef.current = ad;
    ad.load();
  }, [finish, sendToWeb]);

  // 起動時: ATT（トラッキング許可）→ SDK 初期化 → 先読み
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await requestTrackingPermissionsAsync();
      } catch (e) {}
      try {
        await mobileAds().initialize();
      } catch (e) {}
      if (mounted) preloadAd();
    })();
    return () => {
      mounted = false;
    };
  }, [preloadAd]);

  // WebView から「広告を見せて」と言われたとき
  const onMessage = useCallback(
    (event) => {
      const msg = event.nativeEvent.data;
      if (msg !== 'SHOW_REWARDED_AD') return;
      const ad = adRef.current;
      if (ad && loadedRef.current) {
        try {
          ad.show();
        } catch (e) {
          finish(true);
        }
        return;
      }
      // まだ読み込めていない → すぐ答えを見せず、「準備中」を出して読み込みを待つ。
      // LOADED が来れば再生、ERROR かタイムアウトなら答えを通す（ブロックはしない）。
      pendingRef.current = true;
      sendToWeb('window.__onAdLoading && window.__onAdLoading()');
      if (!ad) preloadAd();
      if (waitTimerRef.current) clearTimeout(waitTimerRef.current);
      waitTimerRef.current = setTimeout(() => {
        if (!pendingRef.current) return;
        finish(true);
      }, LOAD_WAIT_MS);
    },
    [finish, preloadAd, sendToWeb]
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#f2ede0" />
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html, baseUrl: 'https://kakeizu.local/' }}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        // WebView 自体のピンチズームを無効化（アプリが独自のズーム/パンを持つため）
        scalesPageToFit={false}
        setBuiltInZoomControls={false}
        style={styles.webview}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f2ede0',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  webview: {
    flex: 1,
    backgroundColor: '#f2ede0',
  },
});
