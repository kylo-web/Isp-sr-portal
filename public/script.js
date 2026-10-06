document.addEventListener('DOMContentLoaded', () => {
    const searchBtn = document.getElementById('searchBtn');
    const customerIdInput = document.getElementById('customerId');
    const searchSection = document.getElementById('searchSection');
    const reportSection = document.getElementById('reportSection');
    const loading = document.getElementById('loading');

    const dispName = document.getElementById('dispName');
    const dispId = document.getElementById('dispId');
    const dispFat = document.getElementById('dispFat');
    const dispStatus = document.getElementById('dispStatus');
    const dispSignal = document.getElementById('dispSignal');

    const issueTypeSelect = document.getElementById('issueType');
    const passwordBox = document.getElementById('passwordBox');
    const newPasswordInput = document.getElementById('newPassword');
    const otherIssueBox = document.getElementById('otherIssueBox');
    const customIssueInput = document.getElementById('customIssue');
    const reportForm = document.getElementById('reportForm');

    let currentCustomerData = null;

    // 🔍 Issue Type Dropdown ပြောင်းလဲမှုကို စောင့်ကြည့်ခြင်း
    issueTypeSelect.addEventListener('change', () => {
        const val = issueTypeSelect.value;
        
        // Password change ရွေးပါက Password Box ပေါ်လာမည်
        if (val.includes('Password change')) {
            passwordBox.classList.remove('hidden');
            newPasswordInput.required = true;
        } else {
            passwordBox.classList.add('hidden');
            newPasswordInput.required = false;
            newPasswordInput.value = '';
        }

        // အခြားပြဿနာ ရွေးပါက Custom Issue Box ပေါ်လာမည်
        if (val.includes('အခြားပြဿနာ')) {
            otherIssueBox.classList.remove('hidden');
        } else {
            otherIssueBox.classList.add('hidden');
            customIssueInput.value = '';
        }
    });

    // 🔍 Search Customer ID
    searchBtn.addEventListener('click', async () => {
        const id = customerIdInput.value.trim();
        if (!id) {
            alert('Customer ID ရိုက်ထည့်ပါ');
            return;
        }

        loading.classList.remove('hidden');
        reportSection.classList.add('hidden');

        try {
            const res = await fetch(`/api/get-customer/${encodeURIComponent(id)}`);
            const data = await res.json();

            loading.classList.add('hidden');

            if (data.success) {
                currentCustomerData = { ...data, inputId: id };
                dispName.textContent = data.username || '-';
                dispId.textContent = id.toUpperCase();
                dispFat.textContent = data.fatBox || '-';
                dispStatus.textContent = data.onuStatus || '-';
                dispSignal.textContent = data.signal && data.signal !== 'N/A' 
                    ? (data.signal.includes('dBm') ? data.signal : `${data.signal} dBm`)
                    : 'N/A';

                reportSection.classList.remove('hidden');
            } else {
                alert(data.message || 'Customer မတွေ့ရှိပါ');
            }
        } catch (err) {
            loading.classList.add('hidden');
            alert('Server နှင့် ချိတ်ဆက်ရာတွင် အမှားရှိနေပါသည်');
        }
    });

    // 📩 Submit Report
    reportForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!currentCustomerData) return;

        let finalIssue = issueTypeSelect.value;

        // Password change ဖြစ်ပါက Input ပါဝင်အောင် ပြုပြင်ခြင်း
        if (finalIssue.includes('Password change')) {
            const pwd = newPasswordInput.value.trim();
            if (!pwd) {
                alert('Password အသစ် ရိုက်ထည့်ပေးပါ');
                return;
            }
            finalIssue = `Password change (New Password: ${pwd})`;
        } else if (finalIssue.includes('အခြားပြဿနာ')) {
            const customText = customIssueInput.value.trim();
            if (customText) {
                finalIssue = `အခြားပြဿနာ: ${customText}`;
            }
        }

        const payload = {
            customerId: currentCustomerData.inputId,
            customerName: currentCustomerData.username,
            fatBox: currentCustomerData.fatBox,
            onuStatus: currentCustomerData.onuStatus,
            signal: currentCustomerData.signal,
            issue: finalIssue
        };

        try {
            const res = await fetch('/api/submit-report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await res.json();
            alert(result.message);

            if (result.success) {
                location.reload();
            }
        } catch (err) {
            alert('Report ပို့ရာတွင် အမှားရှိနေပါသည်');
        }
    });
});
