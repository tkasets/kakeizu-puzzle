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
 *     → ここで AdMob のリワード広告を表示
 *     → 視聴完了/閉じたら window.__onAdFinished(rewarded) を WebView に注入して結果を返す
 */

// 開発中は必ず Google のテスト広告を使う（本番広告の誤クリックはアカウント停止リスク）。
// 本番ビルド(__DEV__=false)では、AdMob で作成した実際のリワード広告ユニットIDを使う。
const REWARDED_UNIT_ID = __DEV__
  ? TestIds.REWARDED
  : 'ca-app-pub-1081803676733486/3954974297';

export default function App() {
  const webRef = useRef(null);
  const adRef = useRef(null);
  const earnedRef = useRef(false);
  const loadedRef = useRef(false);

  const sendToWeb = useCallback((js) => {
    if (webRef.current) webRef.current.injectJavaScript(js + '; true;');
  }, []);

  // リワード広告を1本ぶん用意して先読みする。閉じたら結果を Web に返し、次を先読み。
  const preloadAd = useCallback(() => {
    const ad = RewardedAd.createForAdRequest(REWARDED_UNIT_ID, {
      requestNonPersonalizedAdsOnly: false,
    });
    earnedRef.current = false;
    loadedRef.current = false;

    const unsub = [];
    unsub.push(
      ad.addAdEventListener(RewardedAdEventType.LOADED, () => {
        loadedRef.current = true;
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
        sendToWeb(
          'window.__onAdFinished && window.__onAdFinished(' +
            (earnedRef.current ? 'true' : 'false') +
            ')'
        );
        unsub.forEach((u) => u());
        preloadAd(); // 次回ぶんを先読み
      })
    );
    unsub.push(
      ad.addAdEventListener(AdEventType.ERROR, () => {
        // 広告が出せない時は答えをブロックしないため true で通す
        sendToWeb('window.__onAdFinished && window.__onAdFinished(true)');
        unsub.forEach((u) => u());
        setTimeout(preloadAd, 4000);
      })
    );

    adRef.current = ad;
    ad.load();
  }, [sendToWeb]);

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
          sendToWeb('window.__onAdFinished && window.__onAdFinished(true)');
        }
      } else {
        // まだ読み込めていない → 答えをブロックしないため通しつつ再読み込み
        sendToWeb('window.__onAdFinished && window.__onAdFinished(true)');
        preloadAd();
      }
    },
    [preloadAd, sendToWeb]
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
