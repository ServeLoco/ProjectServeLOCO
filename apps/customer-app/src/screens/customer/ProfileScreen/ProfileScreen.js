/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef, useState } from 'react';
import appJson from '../../../../app.json';
import * as Application from 'expo-application';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Animated,
  Linking,
  RefreshControl,
  Alert,
  AppState,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation } from '@react-navigation/native';
import {
  AppScreen,
  AppHeader,
  AppIcon,
  ConfirmModal,
} from '../../../components';
import * as Notifications from 'expo-notifications';
import { colors, typography, spacing, radius, shadows } from '../../../theme';
import { useAuthStore, useCartStore, useSettingsStore } from '../../../stores';
import { authApi } from '../../../api';
import { requestNotificationPermission } from '../../../hooks/useLocalNotifications';

// Policy pages are served by the API itself at /policies/* (see apps/api/src/app.js).
// Both the customer app's Linking.openURL and any web/marketing link should use
// the same path so there is one source of truth.
const POLICY_URLS = {
  privacy: 'https://api.serveloco.app/policies/privacy',
  terms: 'https://api.serveloco.app/policies/terms',
};

// Brand-level contact links. Update these when social handles change.
const BRAND_LINKS = {
  instagram: 'https://instagram.com/villkro',
  contactEmail: 'mailto:decodelabsofficial@gmail.com',
};

// Section configuration — kept in one place so the menu reads like a
// declarative table of contents. Each row links to the original feature
// with the same handler signature.
const MENU_SECTIONS = [
  {
    key: 'account',
    title: 'Account',
    rows: [
      {
        key: 'edit',
        iconBg: colors.saffronLight,
        iconColor: colors.saffronDark,
        icon: 'edit',
        label: 'Edit Profile',
        caption: 'Name, phone, address',
        action: 'editProfile',
      },
      {
        key: 'orders',
        iconBg: colors.infoLight,
        iconColor: colors.info,
        icon: 'orders',
        label: 'My Orders',
        caption: 'Track current and past orders',
        action: 'orders',
      },
      {
        key: 'notifications',
        iconBg: colors.warningLight,
        iconColor: colors.warning,
        icon: 'notification',
        label: 'Notifications',
        caption: 'notifStatus',
        action: 'notifications',
        isLast: true,
      },
    ],
  },
  {
    key: 'support',
    title: 'Support & Legal',
    rows: [
      {
        key: 'help',
        iconBg: '#E8F8EF',
        iconColor: '#1FB574',
        icon: 'whatsapp',
        label: 'Help & Support',
        caption: 'supportPhone',
        action: 'help',
      },
      {
        key: 'privacy',
        iconBg: colors.primaryLight,
        iconColor: colors.primary,
        icon: 'lock',
        label: 'Privacy Policy',
        caption: 'How we handle your data',
        action: 'privacy',
      },
      {
        key: 'terms',
        iconBg: '#F1F5F9',
        iconColor: '#475569',
        icon: 'settings',
        label: 'Terms of Service',
        caption: 'Rules for using VillKro',
        action: 'terms',
      },
      {
        key: 'data',
        iconBg: colors.saffronLight,
        iconColor: colors.saffronDark,
        icon: 'check',
        label: 'Data Safety',
        caption: 'Permissions, sharing and retention',
        action: 'dataSafety',
      },
      {
        key: 'contact',
        iconBg: '#E0F2FE',
        iconColor: '#0284C7',
        icon: 'mail',
        label: 'Contact us',
        caption: 'decodelabsofficial@gmail.com',
        action: 'contact',
        isLast: true,
      },
    ],
  },
  {
    key: 'actions',
    title: 'Account actions',
    rows: [
      {
        key: 'logout',
        iconBg: '#FFF7ED',
        iconColor: '#9A3412',
        icon: 'logout',
        label: 'Logout',
        caption: 'Log out from this device',
        action: 'logout',
      },
      {
        key: 'delete',
        iconBg: colors.errorLight,
        iconColor: colors.error,
        icon: 'delete',
        label: 'Delete Account',
        caption: '30-day grace period before permanent deletion',
        action: 'delete',
        isLast: true,
        destructive: true,
      },
    ],
  },
];

export default function ProfileScreen() {
  const navigation = useNavigation();
  const user = useAuthStore(state => state.user);
  const profile = useAuthStore(state => state.profile);
  const setProfile = useAuthStore(state => state.setProfile);
  const logout = useAuthStore(state => state.logout);
  const clearCart = useCartStore(state => state.clearCart);
  const supportPhone = useSettingsStore(state => state.supportPhone);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notifStatus, setNotifStatus] = useState(null); // 'granted' | 'denied' | 'undetermined' | null (loading)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // Two-step soft-delete flow: 'confirm' (inform user about 30-day grace,
  // ask to proceed) → 'pending' (deletion scheduled, show banner with Cancel button).
  const [deleteStep, setDeleteStep] = useState(null);

  const heroFade = useRef(new Animated.Value(0)).current;
  const heroSlide = useRef(new Animated.Value(16)).current;
  const sectionsFade = useRef(new Animated.Value(0)).current;
  const sectionsSlide = useRef(new Animated.Value(12)).current;

  const loadProfile = React.useCallback((refresh = false) => {
    if (refresh) setIsRefreshing(true);
    // Capture session identity so a stale /auth/me from a previous login
    // cannot overwrite the current account's profile (token/user desync).
    const { token: requestToken, sessionGeneration } = useAuthStore.getState();
    authApi.getMe()
      .then(response => {
        const current = useAuthStore.getState();
        if (
          current.sessionGeneration !== sessionGeneration
          || (requestToken && current.token !== requestToken)
        ) {
          return;
        }
        const nextProfile = response?.user || response?.profile || response?.data || response;
        if (nextProfile) setProfile(nextProfile);
      })
      .catch(() => {})
      .finally(() => setIsRefreshing(false));
  }, [setProfile]);

  // Live OS permission state — re-checked whenever the screen (re)gains focus
  // so a user who flips it in system Settings sees it reflected here too.
  const refreshNotifStatus = React.useCallback(() => {
    Notifications.getPermissionsAsync()
      .then(({ status }) => setNotifStatus(status))
      .catch(() => setNotifStatus('undetermined'));
  }, []);

  useEffect(() => {
    loadProfile();
    refreshNotifStatus();

    Animated.stagger(120, [
      Animated.parallel([
        Animated.timing(heroFade, { toValue: 1, duration: 480, useNativeDriver: true }),
        Animated.timing(heroSlide, { toValue: 0, duration: 480, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(sectionsFade, { toValue: 1, duration: 360, useNativeDriver: true }),
        Animated.timing(sectionsSlide, { toValue: 0, duration: 360, useNativeDriver: true }),
      ]),
    ]).start();
  }, [loadProfile]);

  // Refetch the profile whenever the app returns to the foreground
  // (e.g. after the user opens WhatsApp from "Help & Support"). Without
  // this the screen stays mounted with stale data and looks empty.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        loadProfile(true);
        refreshNotifStatus();
      }
    });
    return () => subscription?.remove?.();
  }, [loadProfile, refreshNotifStatus]);

  const handleHelpSupport = () => {
    if (supportPhone) {
      const digits = String(supportPhone).replace(/[^0-9]/g, '');
      const withCountryCode = digits.length === 10 ? `91${digits}` : digits;
      openLink(`https://wa.me/${withCountryCode}`);
    }
  };

  const openLink = (url) => {
    Linking.openURL(url).catch(() => {
      Alert.alert('Unable to open link', url);
    });
  };

  const handleLogout = () => {
    clearCart();
    logout();
    setShowLogoutConfirm(false);
  };

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    try {
      await authApi.requestAccountDeletion({});
      // Reload profile so the banner with the scheduled-delete date appears.
      loadProfile(true);
      setDeleteStep('pending');
    } catch (err) {
      Alert.alert(
        'Could not schedule account deletion',
        err?.response?.data?.message || err?.message || 'Please try again or contact support.'
      );
      setDeleteStep('confirm');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCancelDeletion = async () => {
    setIsDeleting(true);
    try {
      await authApi.cancelAccountDeletion();
      loadProfile(true);
      setDeleteStep('confirm');
    } catch (err) {
      Alert.alert(
        'Could not cancel account deletion',
        err?.response?.data?.message || err?.message || 'Please try again.'
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleNotificationsRow = async () => {
    if (notifStatus === 'denied') {
      // Android/iOS won't re-show the system dialog once denied — the only
      // way back is the app's own notification settings page.
      Linking.openSettings().catch(() => {});
      return;
    }
    if (notifStatus === 'granted') {
      Alert.alert('Notifications are on', "You'll get order updates and offers on this device.");
      return;
    }
    const result = await requestNotificationPermission();
    setNotifStatus(result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'undetermined');
  };

  const handleRowAction = (action) => {
    switch (action) {
      case 'notifications':
        handleNotificationsRow();
        break;
      case 'editProfile':
        navigation.navigate('EditProfile');
        break;
      case 'orders':
        navigation.navigate('MainTabs', { screen: 'Orders' });
        break;
      case 'help':
        handleHelpSupport();
        break;
      case 'privacy':
        openLink(POLICY_URLS.privacy);
        break;
      case 'terms':
        openLink(POLICY_URLS.terms);
        break;
      case 'dataSafety':
        openLink(POLICY_URLS.privacy);
        break;
      case 'instagram':
        openLink(BRAND_LINKS.instagram);
        break;
      case 'contact':
        openLink(BRAND_LINKS.contactEmail);
        break;
      case 'logout':
        setShowLogoutConfirm(true);
        break;
      case 'delete':
        setDeleteStep('confirm');
        break;
      default:
        break;
    }
  };

  const statusLabel = profile?.status || (profile?.trusted ? 'Trusted' : 'Active');
  const statusColor =
    statusLabel === 'Blocked' ? colors.error :
    statusLabel === 'Trusted' ? colors.success :
    colors.primary;

  return (
    <AppScreen style={styles.container} safeAreaBottom={false}>
      <AppHeader title="Profile" />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => loadProfile(true)}
            tintColor={colors.primary}
            colors={[colors.primary, colors.success, colors.saffron]}
            title="Refreshing VillKro"
            titleColor={colors.textSecondary}
          />
        }
      >
        {/* Hero card with gradient + avatar + identity */}
        <Animated.View
          style={[
            styles.hero,
            { opacity: heroFade, transform: [{ translateY: heroSlide }] },
          ]}
        >
          <LinearGradient
            colors={[colors.brandGradientStart, colors.brandGradientEnd]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroGradient}
          >
            {/* Decorative blobs */}
            <View style={styles.heroBlobA} pointerEvents="none" />
            <View style={styles.heroBlobB} pointerEvents="none" />

            <View style={styles.heroTopRow}>
              <View style={styles.avatarRing}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {profile?.name ? profile.name.charAt(0).toUpperCase() : 'U'}
                  </Text>
                </View>
                <View style={styles.avatarBadge}>
                  <AppIcon name="star" size={10} color={colors.textInverse} strokeWidth={3} />
                </View>
              </View>

              <View style={styles.heroIdentity}>
                <Text style={styles.heroName} numberOfLines={1}>
                  {profile?.name || 'Welcome to VillKro'}
                </Text>
                <Text style={styles.heroPhone} numberOfLines={1}>
                  {user?.phone || 'No phone added'}
                </Text>
                <View style={styles.heroChipsRow}>
                  <View style={styles.heroChip}>
                    <AppIcon name="star" size={11} color={colors.warning} strokeWidth={2.6} />
                    <Text style={styles.heroChipText}>VillKro Member</Text>
                  </View>
                  <View style={[styles.heroChip, styles.heroChipGhost]}>
                    <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                    <Text style={[styles.heroChipGhostText, { color: statusColor }]}>
                      {statusLabel}
                    </Text>
                  </View>
                </View>
              </View>

              <TouchableOpacity
                style={styles.heroEditBtn}
                onPress={() => navigation.navigate('EditProfile')}
                accessibilityRole="button"
                accessibilityLabel="Edit profile"
                activeOpacity={0.78}
              >
                <AppIcon name="edit" size={16} color={colors.textInverse} strokeWidth={2.4} />
              </TouchableOpacity>
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Instagram follow card */}
        <TouchableOpacity
          style={styles.igCard}
          onPress={() => openLink(BRAND_LINKS.instagram)}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Follow us on Instagram"
        >
          <LinearGradient
            colors={['#F58529', '#DD2A7B', '#8134AF', '#515BD4']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.igGradient}
          >
            {/* Decorative shapes */}
            <View style={styles.igBlobA} pointerEvents="none" />
            <View style={styles.igBlobB} pointerEvents="none" />
            <View style={styles.igBlobC} pointerEvents="none" />

            <View style={styles.igTopRow}>
              <View style={styles.igIconBubble}>
                <AppIcon name="atsign" size={20} color="#FFFFFF" strokeWidth={2.6} />
              </View>
              <View style={styles.igTag}>
                <Text style={styles.igTagText}>SOCIAL</Text>
              </View>
            </View>

            <View style={styles.igMiddle}>
              <Text style={styles.igTitle}>Follow us on Instagram</Text>
              <Text style={styles.igHandle}>@villkro</Text>
              <Text style={styles.igSubtitle}>
                Behind-the-scenes, offers and updates from your local shop
              </Text>
            </View>

            <View style={styles.igBottomRow}>
              <View style={styles.igFollowBtn}>
                <Text style={styles.igFollowBtnText}>Follow</Text>
              </View>
              <View style={styles.igArrow}>
                <AppIcon name="chevronRight" size={18} color="#FFFFFF" strokeWidth={2.6} />
              </View>
            </View>
          </LinearGradient>
        </TouchableOpacity>

        {/* Address / info panel */}
        <View style={styles.addressCard}>
          <View style={styles.addressIconBubble}>
            <AppIcon name="location" size={16} color={colors.primary} />
          </View>
          <View style={styles.addressContent}>
            <Text style={styles.addressLabel}>Delivery address</Text>
            <Text style={styles.addressText} numberOfLines={2}>
              {profile?.address || 'No address added yet. Tap to set your delivery location.'}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.addressEditChip}
            onPress={() => navigation.navigate('EditProfile')}
            activeOpacity={0.78}
            accessibilityRole="button"
            accessibilityLabel="Edit address"
          >
            <AppIcon name="edit" size={13} color={colors.primary} strokeWidth={2.4} />
            <Text style={styles.addressEditChipText}>Edit</Text>
          </TouchableOpacity>
        </View>

        {/* Status banners (blocked / pending deletion) */}
        {profile?.status === 'Blocked' && (
          <View style={styles.blockedBanner}>
            <View style={styles.blockedBannerIcon}>
              <AppIcon name="close" size={14} color={colors.error} strokeWidth={2.6} />
            </View>
            <Text style={styles.blockedText}>
              Your account is currently restricted. Contact support to restore access.
            </Text>
          </View>
        )}

        {profile?.deletionRequestedAt && (
          <View style={styles.deletionBanner}>
            <View style={styles.deletionBannerHead}>
              <View style={styles.deletionBannerIcon}>
                <AppIcon name="warning" size={14} color="#B45309" strokeWidth={2.6} />
              </View>
              <Text style={styles.deletionBannerTitle}>Account deletion scheduled</Text>
            </View>
            <Text style={styles.deletionBannerBody}>
              Your account and data will be permanently deleted on{' '}
              <Text style={styles.deletionBannerDate}>
                {new Date(new Date(profile.deletionRequestedAt).getTime() + 30 * 24 * 60 * 60 * 1000)
                  .toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}
              </Text>{' '}
              (30 days from confirmation).
            </Text>
            <TouchableOpacity
              style={styles.cancelDeleteBtn}
              onPress={handleCancelDeletion}
              disabled={isDeleting}
              activeOpacity={0.78}
            >
              <AppIcon name="check" size={14} color="#FFFFFF" strokeWidth={2.6} />
              <Text style={styles.cancelDeleteBtnText}>
                {isDeleting ? 'Cancelling…' : 'Cancel deletion'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Menu sections */}
        <Animated.View
          style={[
            styles.menuContainer,
            { opacity: sectionsFade, transform: [{ translateY: sectionsSlide }] },
          ]}
        >
          {MENU_SECTIONS.map((section) => (
            <View key={section.key} style={styles.menuSection}>
              <Text style={styles.menuSectionTitle}>{section.title}</Text>
              <View style={styles.menuCard}>
                {section.rows.map((row) => {
                  const caption = row.caption === 'supportPhone'
                    ? (supportPhone ? `Chat on WhatsApp (+91 ${supportPhone.replace(/[^0-9]/g, '').slice(-10)})` : 'Contact shop support')
                    : row.caption === 'notifStatus'
                    ? (notifStatus === 'granted' ? 'On — order and offer updates'
                      : notifStatus === 'denied' ? 'Off — tap to enable in Settings'
                      : notifStatus === null ? 'Checking…'
                      : 'Off — tap to enable')
                    : row.caption;
                  return (
                    <MenuRow
                      key={row.key}
                      icon={row.icon}
                      iconBg={row.iconBg}
                      iconColor={row.iconColor}
                      label={row.label}
                      caption={caption}
                      destructive={row.destructive}
                      isLast={row.isLast}
                      onPress={() => handleRowAction(row.action)}
                    />
                  );
                })}
              </View>
            </View>
          ))}
        </Animated.View>

        {/* Footer */}
        <View style={styles.footer}>
          <View style={styles.footerDivider} />
          <View style={styles.footerLine}>
            <Text style={styles.footerBrand}>Made in Gorakhpur with </Text>
            <Text style={styles.footerHeart}>❤️</Text>
            <Text style={styles.footerBrand}> (Haryana)</Text>
          </View>
          {/* Native binary version — what's actually installed from the Play
              Store. appJson.expo.version is only a fallback because after an
              OTA update it reflects the JS bundle, not the installed binary. */}
          <Text style={styles.footerVersion}>
            v{Application.nativeApplicationVersion ?? appJson?.expo?.version ?? '1.1.1'}
          </Text>
        </View>
      </ScrollView>

      <ConfirmModal
        visible={showLogoutConfirm}
        title="Logout?"
        message="You will need to login again to place orders and view your account."
        confirmLabel="Logout"
        cancelLabel="Stay"
        confirmVariant="danger"
        onCancel={() => setShowLogoutConfirm(false)}
        onConfirm={handleLogout}
      />

      {/* Soft-delete flow — step 1: warn + confirm. */}
      <ConfirmModal
        visible={deleteStep === 'confirm'}
        title="Schedule account deletion?"
        message="Your account and data will be permanently deleted 30 days from now. You can cancel anytime in this Profile screen during the grace period — just tap 'Cancel deletion' on the banner above."
        confirmLabel="Schedule deletion"
        cancelLabel="Keep account"
        confirmVariant="danger"
        confirmLoading={isDeleting}
        onCancel={() => setDeleteStep(null)}
        onConfirm={handleDeleteAccount}
      />

      {/* Soft-delete flow — step 2: success, show info card with close button. */}
      <ConfirmModal
        visible={deleteStep === 'pending'}
        title="Deletion scheduled"
        message="Your account will be permanently deleted in 30 days. You can keep using the app until then. To undo, tap 'Cancel deletion' on the banner above — your account and data will be fully restored."
        confirmLabel="Got it"
        cancelLabel={false}
        confirmVariant="primary"
        onCancel={null}
        onConfirm={() => setDeleteStep(null)}
      />
    </AppScreen>
  );
}

/* ------------------------------------------------------------------------- */
/* Sub-components                                                              */
/* ------------------------------------------------------------------------- */

function MenuRow({ icon, iconBg, iconColor, label, caption, destructive, isLast, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.menuRow, isLast && styles.menuRowLast]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.menuRowIcon, { backgroundColor: iconBg }]}>
        <AppIcon name={icon} size={17} color={iconColor} strokeWidth={2.2} />
      </View>
      <View style={styles.menuRowContent}>
        <Text style={[styles.menuRowLabel, destructive && { color: colors.error }]} numberOfLines={1}>
          {label}
        </Text>
        {caption ? (
          <Text style={styles.menuRowCaption} numberOfLines={1}>{caption}</Text>
        ) : null}
      </View>
      <View style={styles.menuRowChevron}>
        <AppIcon name="chevronRight" size={16} color={colors.textTertiary} />
      </View>
    </TouchableOpacity>
  );
}

/* ------------------------------------------------------------------------- */
/* Styles                                                                     */
/* ------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },
  scrollContent: {
    paddingBottom: 120,
  },

  /* ----- Hero ----- */
  hero: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    borderRadius: radius.xxl,
    overflow: 'hidden',
    ...shadows.cardRaised,
  },
  heroGradient: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    position: 'relative',
    overflow: 'hidden',
  },
  heroBlobA: {
    position: 'absolute',
    top: -60,
    right: -40,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  heroBlobB: {
    position: 'absolute',
    bottom: -70,
    left: -30,
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    zIndex: 1,
  },
  avatarRing: {
    width: 78,
    height: 78,
    borderRadius: 26,
    padding: 4,
    backgroundColor: 'rgba(255,255,255,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {
    width: 70,
    height: 70,
    borderRadius: 22,
    backgroundColor: colors.textInverse,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.md,
  },
  avatarText: {
    ...typography.hero,
    color: colors.saffronDark,
    fontWeight: '900',
  },
  avatarBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.warning,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2.5,
    borderColor: '#FFFFFF',
  },
  heroIdentity: {
    flex: 1,
    minWidth: 0,
  },
  heroName: {
    ...typography.h2,
    color: colors.brandInk,
    fontWeight: '900',
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  heroPhone: {
    ...typography.caption,
    color: 'rgba(26,31,43,0.7)',
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  heroChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  heroChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  heroChipText: {
    ...typography.caption,
    fontSize: 10,
    fontWeight: '900',
    color: colors.warning,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  heroChipGhost: {
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
  heroChipGhostText: {
    ...typography.caption,
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 2,
  },
  heroEditBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ----- Address card ----- */
  addressCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  addressIconBubble: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addressContent: {
    flex: 1,
    minWidth: 0,
  },
  addressLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  addressText: {
    ...typography.bodySmall,
    color: colors.textPrimary,
    lineHeight: 18,
  },
  addressEditChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.primaryLight,
  },
  addressEditChipText: {
    ...typography.caption,
    fontWeight: '800',
    color: colors.primary,
  },

  /* ----- Instagram follow card ----- */
  igCard: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    borderRadius: radius.xxl,
    overflow: 'hidden',
    ...shadows.cardRaised,
  },
  igGradient: {
    padding: spacing.md,
    position: 'relative',
    overflow: 'hidden',
    minHeight: 156,
    justifyContent: 'space-between',
  },
  igBlobA: {
    position: 'absolute',
    top: -40,
    right: -30,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  igBlobB: {
    position: 'absolute',
    bottom: -50,
    left: -20,
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  igBlobC: {
    position: 'absolute',
    top: 40,
    right: 80,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  igTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 1,
  },
  igIconBubble: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  igTag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  igTagText: {
    ...typography.caption,
    fontSize: 9,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 1.2,
  },
  igMiddle: {
    zIndex: 1,
    marginTop: 2,
    marginBottom: 2,
  },
  igTitle: {
    ...typography.labelLarge,
    color: '#FFFFFF',
    fontWeight: '900',
    letterSpacing: -0.2,
  },
  igHandle: {
    ...typography.h3,
    color: '#FFFFFF',
    fontWeight: '900',
    letterSpacing: -0.3,
    marginTop: 2,
    marginBottom: 4,
  },
  igSubtitle: {
    ...typography.caption,
    color: 'rgba(255,255,255,0.92)',
    lineHeight: 15,
    fontWeight: '500',
  },
  igBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 1,
  },
  igFollowBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: '#FFFFFF',
    ...shadows.sm,
  },
  igFollowBtnText: {
    ...typography.buttonSmall,
    color: '#8134AF',
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  igArrow: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.32)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ----- Status banners ----- */
  blockedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.errorLight,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.errorBorder,
  },
  blockedBannerIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(229,72,77,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  blockedText: {
    ...typography.bodySmall,
    color: colors.error,
    fontWeight: '600',
    flex: 1,
    lineHeight: 18,
  },
  deletionBanner: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    backgroundColor: '#FFFBEB',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#FCD34D',
    padding: spacing.md,
    gap: 6,
  },
  deletionBannerHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  deletionBannerIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(180,83,9,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deletionBannerTitle: {
    ...typography.labelLarge,
    color: '#92400E',
    fontWeight: '800',
    flex: 1,
  },
  deletionBannerBody: {
    ...typography.bodySmall,
    color: '#78350F',
    lineHeight: 18,
  },
  deletionBannerDate: {
    fontWeight: '800',
  },
  cancelDeleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: '#92400E',
    marginTop: 4,
  },
  cancelDeleteBtnText: {
    ...typography.caption,
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 12,
  },

  /* ----- Menu sections ----- */
  menuContainer: {
    marginTop: spacing.lg,
  },
  menuSection: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  menuSectionTitle: {
    ...typography.captionMedium,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
    marginLeft: spacing.sm,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  menuCard: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadows.card,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  menuRowLast: {
    borderBottomWidth: 0,
  },
  menuRowIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuRowContent: {
    flex: 1,
    minWidth: 0,
  },
  menuRowLabel: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '800',
    lineHeight: 18,
    marginBottom: 2,
  },
  menuRowCaption: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 14,
  },
  menuRowChevron: {
    width: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ----- Footer ----- */
  footer: {
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  footerDivider: {
    width: 40,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.md,
  },
  footerBrand: {
    ...typography.h4,
    color: colors.textPrimary,
    fontWeight: '900',
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  footerLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  footerHeart: {
    fontSize: 16,
    marginHorizontal: 2,
  },
  footerTag: {
    ...typography.caption,
    color: colors.textTertiary,
  },
  footerVersion: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: 4,
    letterSpacing: 0.3,
  },
});