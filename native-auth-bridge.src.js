import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { Capacitor } from '@capacitor/core';

window.MombongoNativeAuth = {
  isNative: function () {
    return Capacitor.isNativePlatform();
  },
  signInWithGoogle: function () {
    return FirebaseAuthentication.signInWithGoogle();
  },
  signOut: function () {
    return FirebaseAuthentication.signOut();
  }
};
